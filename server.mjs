import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import express from 'express';
import multer from 'multer';
import pg from 'pg';
import {buildPremiumPaidContent,sendCredentialsEmail,sendBasicAccessEmail,sendAdminMailAlert} from './email.mjs';
import {createCheckout,identifyCheckout,premiumPasswordForOrder,quotePrice,normalizeBuyerName,restoreCheckout} from './checkout.mjs';
import {buildDirectPaymentForm} from './payment-recovery.mjs';
import {describeRejectedLogin,emailDiagnosticKey,rejectedLoginHint} from './login-diagnostics.mjs';
import {CONSENT_SCHEMA,archiveConsentDocuments,checkoutDocumentCatalog,validateCheckoutConsents,saveCheckoutConsentReceipt,renderArchivedLegalDocument} from './consents.mjs';
import {createPdfRouter,loadPdfCatalog,rewritePdfLinks} from './pdf-access.mjs';
import {createPodcastRouter,loadPodcastCatalog} from './podcast-access.mjs';
import {readCloudConfig,CloudPaymentsError,cents} from './cloudpayments.mjs';
import {CLOUD_SCHEMA,createCloudStore,drainAccessMail} from './cloudpayments-store.mjs';
import {createCloudService,mountCloudNotifications} from './cloudpayments-router.mjs';
import {ADMIN_SCHEMA,CHECKOUT_PROVIDER_SCHEMA,createAdminStore} from './admin-store.mjs';
import {mountAdmin} from './admin-access.mjs';
import {HISTORY_SCHEMA,createPaymentHistory} from './payment-history.mjs';
import {MAIL_MONITOR_SCHEMA,pollMailStatuses,notifyMailAttention} from './mail-monitor.mjs';
import {PRODAMUS_MAIL_SCHEMA,PLATFORM_ACCESS_NOTICE,prodamusDeliveryMode,saveProdamusMailOrder,getProdamusMailOrder,fulfillProdamusMailOrder} from './prodamus-mail.mjs';

const {Pool}=pg;
const scryptAsync=promisify(crypto.scrypt);
const app=express();
const pdfCatalog=await loadPdfCatalog();
const podcastCatalog=await loadPodcastCatalog();
const upload=multer({limits:{fields:200,fieldSize:1024*1024}});
const PORT=Number(process.env.PORT||3000);
const PUBLIC_URL=(process.env.PUBLIC_URL||'').replace(/\/$/,'');
const SESSION_DAYS=Number(process.env.SESSION_DAYS||30);
const COOKIE_SECURE=process.env.COOKIE_SECURE!=='false'&&process.env.NODE_ENV==='production';
const SALES_ORIGINS=(process.env.SALES_ORIGINS||'https://sales-club-fabrika-zagotovok-kozlovheritage.onreza.app').split(',').map(x=>x.trim()).filter(Boolean);
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==='false'?false:{rejectUnauthorized:false}});
const historyStore=createPaymentHistory(pool);
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
if(!PUBLIC_URL||!/^https:\/\//.test(PUBLIC_URL))throw new Error('PUBLIC_URL must be an HTTPS site address');
credentialKey();
const cloudConfig=readCloudConfig();
const prodamusDelivery=prodamusDeliveryMode();
const prodamusWorkerEnabled=process.env.PRODAMUS_ACCESS_WORKER_ENABLED==='true';
let mailRuntimeEnabled=false;
const adminEnabled=process.env.CLUB_ADMIN_ENABLED==='true';
const alertsConfigured=/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.CLUB_ADMIN_ALERT_EMAIL||'');
const adminStore=createAdminStore(pool,{
  async resolveCredential(client,order,mail){
    const user=(await client.query(`SELECT u.password_hash,u.credential_email_ciphertext,u.status,u.tariff,
      (u.access_until IS NULL OR u.access_until>now()) AS valid,
      (SELECT password_ciphertext FROM club_admin_credentials WHERE user_key=u.email) AS admin_password_ciphertext
      FROM club_users u WHERE u.email=$1 FOR UPDATE`,[mail.user_key])).rows[0];
    if(!user||!user.valid||user.status!=='active'||user.tariff!=='premium')return null;
    const password=await recoverCurrentPassword(user,order,mail);
    if(!password)return null;
    return encryptPassword(password);
  },
  async revealCredential(user,order,mail){
    const password=await recoverCurrentPassword(user,order,mail);
    return password?{password,ciphertext:encryptPassword(password)}:null;
  },
  async createResetCredential(){
    const password=generatePassword();
    return {password,passwordHash:await hashPassword(password),passwordTag:sha256('club-order-password:'+password),
      vaultCiphertext:encryptPassword(password),mailCiphertext:encryptPassword(password)};
  }
});
// Never activate a new processor from a stale deployment environment value.
const initialCheckoutProvider='prodamus';
const cloudStore=createCloudStore(pool,{
  test:cloudConfig.test,
  receiptProvider:cloudConfig.receiptProvider,
  async grantPremium(client,order){
    const userKey='order:'+order.order_id;
    const existing=await client.query('SELECT email,status FROM club_users WHERE (email=$1 OR login_email=$2) AND password_hash IS NOT NULL FOR UPDATE',[userKey,order.buyer_email]);
    if(existing.rowCount&&existing.rows.some(user=>user.email!==userKey||user.status!=='active'))return {review:true};
    const password=premiumPasswordForOrder(order.order_id,process.env.AUTH_CREDENTIAL_KEY);
    if(!password||!normalizeBuyerName(order.buyer_name))throw new CloudPaymentsError('Не удалось проверить получателя доступа',422);
    const hash=await hashPassword(password);
    await client.query(`INSERT INTO club_users (email,login_email,password_tag,name,password_hash,tariff,access_until,purchase_at,status)
      VALUES ($1,$2,$3,$4,$5,'premium',NULL,now(),'active') ON CONFLICT (email) DO NOTHING`,
    [userKey,order.buyer_email,sha256('club-order-password:'+password),order.buyer_name,hash]);
    return {userKey,ciphertext:encryptPassword(password)};
  }
});
const cloudService=createCloudService(cloudConfig,cloudStore,{siteUrl:PUBLIC_URL});

const schema=[
  "CREATE TABLE IF NOT EXISTS club_users (email TEXT PRIMARY KEY, name TEXT, password_hash TEXT, tariff TEXT NOT NULL DEFAULT 'premium', access_until TIMESTAMPTZ, purchase_at TIMESTAMPTZ, welcome_email_sent_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "ALTER TABLE club_users ALTER COLUMN access_until DROP NOT NULL",
  "ALTER TABLE club_users ADD COLUMN IF NOT EXISTS password_hash TEXT",
  "ALTER TABLE club_users ADD COLUMN IF NOT EXISTS welcome_email_sent_at TIMESTAMPTZ",
  "CREATE TABLE IF NOT EXISTS club_sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES club_users(email) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "ALTER TABLE club_users ADD COLUMN IF NOT EXISTS login_email TEXT",
  "ALTER TABLE club_users ADD COLUMN IF NOT EXISTS password_tag TEXT",
  "CREATE INDEX IF NOT EXISTS club_users_login_email_tag ON club_users (login_email,password_tag)",
  "CREATE TABLE IF NOT EXISTS club_webhook_events (event_id TEXT PRIMARY KEY, payload JSONB NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "ALTER TABLE club_users ADD COLUMN IF NOT EXISTS credential_email_ciphertext TEXT",
  "ALTER TABLE club_users ADD COLUMN IF NOT EXISTS credential_claimed_at TIMESTAMPTZ",
  "CREATE TABLE IF NOT EXISTS club_checkout_orders (order_id TEXT PRIMARY KEY, buyer_email TEXT NOT NULL, buyer_name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS club_login_diagnostics (incident TEXT PRIMARY KEY, metadata JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "UPDATE club_users SET access_until=NULL WHERE tariff='premium' AND status='active' AND access_until IS NOT NULL"
];
function normalizeEmail(value){return String(value||'').trim().toLowerCase();}
function basicInviteUrl(){
  try{
    const url=new URL(process.env.BASIC_ACCESS_URL||'');
    return url.protocol==='https:'&&['t.me','telegram.me'].includes(url.hostname)&&
      url.pathname.length>1&&!url.username&&!url.password&&!url.search&&!url.hash ? url.href : null;
  }catch{return null;}
}
function sha256(value){return crypto.createHash('sha256').update(value,'utf8').digest('hex');}
function randomToken(){return crypto.randomBytes(32).toString('base64url');}
function generatePassword(){return 'Fz-'+crypto.randomBytes(9).toString('base64url');}
async function hashPassword(password){const salt=crypto.randomBytes(16).toString('hex');const key=await scryptAsync(password,salt,64);return 'scrypt$'+salt+'$'+key.toString('hex');}
async function verifyPassword(password,stored){try{const parts=String(stored||'').split('$');if(parts.length!==3||parts[0]!=='scrypt')return false;const key=await scryptAsync(password,parts[1],64);const expected=Buffer.from(parts[2],'hex');return expected.length===key.length&&crypto.timingSafeEqual(expected,key);}catch(error){return false;}}
function credentialKey(){if(!process.env.AUTH_CREDENTIAL_KEY||process.env.AUTH_CREDENTIAL_KEY.length<32)throw new Error('AUTH_CREDENTIAL_KEY must contain at least 32 characters');return crypto.createHash('sha256').update(process.env.AUTH_CREDENTIAL_KEY).digest();}
function encryptPassword(password){const nonce=crypto.randomBytes(12);const cipher=crypto.createCipheriv('aes-256-gcm',credentialKey(),nonce);const data=Buffer.concat([cipher.update(password,'utf8'),cipher.final()]);return [nonce,cipher.getAuthTag(),data].map(x=>x.toString('base64url')).join('.');}
function decryptPassword(stored){const [iv,tag,data]=stored.split('.').map(x=>Buffer.from(x,'base64url'));const decipher=crypto.createDecipheriv('aes-256-gcm',credentialKey(),iv);decipher.setAuthTag(tag);return Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8');}
async function recoverCurrentPassword(user,order,mail){
  const candidates=[];
  for(const encrypted of [user.admin_password_ciphertext,user.credential_email_ciphertext,mail?.password_ciphertext]){
    if(!encrypted)continue;
    try{candidates.push(decryptPassword(encrypted));}catch{}
  }
  const derived=premiumPasswordForOrder(order.order_id,process.env.AUTH_CREDENTIAL_KEY);
  if(derived)candidates.push(derived);
  for(const password of candidates)if(await verifyPassword(password,user.password_hash))return password;
  return null;
}
function safeEqualHex(left,right){if(!left||!right||left.length!==right.length)return false;return crypto.timingSafeEqual(Buffer.from(left),Buffer.from(right));}
function sortAndStringify(value){
  if(Array.isArray(value))return value.map(sortAndStringify);
  if(value&&typeof value==='object')return Object.keys(value).sort().reduce((out,key)=>{out[key]=sortAndStringify(value[key]);return out;},{});
  return value===null||value===undefined?'':String(value);
}
function prodamusSign(payload,secret){const normalized=JSON.stringify(sortAndStringify(payload)).replace(/\//g,'\\/');return crypto.createHmac('sha256',secret).update(normalized,'utf8').digest('hex');}
function setDeep(target,path,value){
  const parts=path.replace(/\]/g,'').split('[');let cursor=target;
  for(let i=0;i<parts.length;i+=1){const part=parts[i];if(!part||part==='__proto__'||part==='constructor'||part==='prototype')return;const last=i===parts.length-1;if(last){if(cursor[part]===undefined)cursor[part]=value;else if(Array.isArray(cursor[part]))cursor[part].push(value);else cursor[part]=[cursor[part],value];return;}const nextIsIndex=/^\d+$/.test(parts[i+1]);if(cursor[part]===undefined)cursor[part]=nextIsIndex?[]:{};cursor=cursor[part];}
}
function normalizeWebhookBody(body){if(!body||typeof body!=='object')return {};if(!Object.keys(body).some(key=>key.includes('[')))return body;const result={};Object.entries(body).forEach(([key,value])=>setDeep(result,key,value));return result;}
function parseCookies(header){return String(header||'').split(';').reduce((out,part)=>{const index=part.indexOf('=');if(index<0)return out;out[part.slice(0,index).trim()]=decodeURIComponent(part.slice(index+1).trim());return out;},{});}
function cookieHeader(name,value,maxAge){return name+'='+encodeURIComponent(value)+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+maxAge+(COOKIE_SECURE?'; Secure':'');}
function clearCookieHeader(name){return name+'=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'+(COOKIE_SECURE?'; Secure':'');}
async function initDatabase(){
  for(const statement of [...schema,...CONSENT_SCHEMA,...(adminEnabled?ADMIN_SCHEMA:[])])await pool.query(statement);
  const existing=(await pool.query("SELECT to_regclass('club_cp_orders') AS name")).rows[0].name;
  // Turning the switch back off must not abandon already-issued platform orders.
  mailRuntimeEnabled=cloudConfig.enabled||prodamusDelivery==='platform'||Boolean(existing);
  if(mailRuntimeEnabled)for(const statement of [...CLOUD_SCHEMA,...MAIL_MONITOR_SCHEMA,...PRODAMUS_MAIL_SCHEMA])await pool.query(statement);
  if(adminEnabled)for(const statement of HISTORY_SCHEMA)await pool.query(statement);
  await archiveConsentDocuments(pool);
}
async function findSession(req){const raw=parseCookies(req.headers.cookie).club_session;if(!raw)return null;const result=await pool.query("SELECT u.email AS user_key,COALESCE(u.login_email,u.email) AS email,u.name,u.tariff,u.purchase_at,u.access_until FROM club_sessions s JOIN club_users u ON u.email=s.email WHERE s.token_hash=$1 AND s.expires_at>now() AND u.status='active' AND u.tariff='premium' AND (u.access_until IS NULL OR u.access_until>now())",[sha256(raw)]);return result.rows[0]||null;}
async function requireAuth(req,res,next){try{const user=await findSession(req);if(!user)return res.status(401).json({message:'Сессия истекла'});req.user=user;next();}catch(error){next(error);}}

mountCloudNotifications(app,express,cloudService);
app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:true,limit:'1mb'}));
mountAdmin(app,express,{enabled:adminEnabled,cloudEnabled:()=>mailRuntimeEnabled,
  paymentProvider:()=>adminStore.activeCheckoutProvider(),findSession,store:adminStore,historyStore,
  siteUrl:PUBLIC_URL,key:process.env.AUTH_CREDENTIAL_KEY,alertsConfigured,
  checkStatus:orderId=>pollMailStatuses(pool,{orderId})});
app.get('/api/health',(req,res)=>res.json({ok:true}));
app.get('/api/legal/checkout-documents',(req,res)=>{
  const origin=req.get('Origin');
  if(origin&&SALES_ORIGINS.includes(origin)){res.set('Access-Control-Allow-Origin',origin);res.set('Vary','Origin');}
  res.set('Cache-Control','no-store').json(checkoutDocumentCatalog(PUBLIC_URL));
});
app.get(['/legal/documents/:id','/legal/documents/:id/original.docx'],async(req,res,next)=>{
  try{
    if(!/^(personal-data|policy|marketing|offer)-[a-f0-9]{64}$/.test(req.params.id))return res.status(404).end();
    const result=await pool.query('SELECT document_id,title,content_html,original_docx FROM club_legal_documents WHERE document_id=$1',[req.params.id]);
    const doc=result.rows[0];if(!doc)return res.status(404).end();
    res.set('Cache-Control','public, max-age=31536000, immutable');
    res.set('X-Content-Type-Options','nosniff');
    res.set('Referrer-Policy','no-referrer');
    if(req.path.endsWith('/original.docx')){
      res.set('Content-Disposition','attachment; filename="club-legal-document.docx"');
      return res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(doc.original_docx);
    }
    res.set('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    res.type('html').send(renderArchivedLegalDocument(doc));
  }catch(error){next(error);}
});
app.use('/api/checkout',(req,res,next)=>{
  const origin=req.get('Origin');
  if(!origin||!SALES_ORIGINS.includes(origin))return res.status(403).json({message:'Недоступный источник'});
  res.set('Access-Control-Allow-Origin',origin);
  res.set('Vary','Origin');
  if(req.method==='OPTIONS'){
    res.set('Access-Control-Allow-Methods','POST, OPTIONS');
    res.set('Access-Control-Allow-Headers','Content-Type');
    return res.status(204).end();
  }
  next();
});
app.post('/api/checkout/session',async(req,res,next)=>{
  let checkoutProvider;
  try{checkoutProvider=await adminStore.activeCheckoutProvider();}catch(error){return next(error);}
  if(checkoutProvider==='cloudpayments'&&req.body?.checkoutProtocol!==2)
    return res.status(409).json({message:'Форма оплаты обновилась. Обновите страницу сайта и попробуйте ещё раз.'});
  const tariff=req.body?.tariff;
  if(tariff!=='basic'&&tariff!=='premium')return res.status(400).json({message:'Неизвестный тариф'});
  const email=normalizeEmail(req.body?.email);
  if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({message:'Укажите email для письма с доступом'});
  const buyerName=tariff==='premium'?normalizeBuyerName(req.body?.buyerName):null;
  if(tariff==='premium'&&!buyerName)return res.status(400).json({message:'Укажите имя и фамилию'});
  let quote;
  try{quote=quotePrice(tariff,req.body?.promo??'');}
  catch(error){return res.status(400).json({message:error.message});}
  let consents;
  try{consents=validateCheckoutConsents(req.body?.consents);}
  catch(error){return res.status(error.status||400).json({message:error.message});}
  if(tariff==='basic'&&process.env.BASIC_CHECKOUT_ENABLED!=='true')return res.status(503).json({message:'Оплата базового тарифа пока недоступна'});
  const invite=tariff==='basic'&&basicInviteUrl();
  if(tariff==='basic'&&!invite)return res.status(503).json({message:'Доступ в Telegram-клуб пока не настроен'});
  try{
    if(tariff==='premium'){
      const existing=await pool.query("SELECT 1 FROM club_users WHERE (email=$1 OR login_email=$1) AND password_hash IS NOT NULL LIMIT 1",[email]);
      if(existing.rowCount)return res.status(409).json({message:'У вас уже есть доступ по этому email. Войдите в клуб или обратитесь в службу заботы, если забыли пароль.'});
    }
    const checkout=createCheckout(tariff,process.env.AUTH_CREDENTIAL_KEY,process.env,email,quote.codes.join(' '),tariff==='premium'?buyerName:undefined);
    if(!checkout)return res.status(503).json({message:'Оплата пока недоступна'});
    {
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        if(tariff==='premium')await client.query('INSERT INTO club_checkout_orders (order_id,buyer_email,buyer_name) VALUES ($1,$2,$3)',[checkout.order_id,email,buyerName]);
        await saveCheckoutConsentReceipt(client,{orderId:checkout.order_id,email,tariff,origin:req.get('Origin')||'direct-api',consents});
        if(checkoutProvider==='prodamus'&&mailRuntimeEnabled)
          await saveProdamusMailOrder(client,checkout,tariff,prodamusDelivery);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
      finally{client.release();}
    }
    if(checkoutProvider==='cloudpayments'){
      const payment=await cloudService.create(checkout,tariff);
      return res.set('Cache-Control','no-store').json(payment);
    }
    checkout.provider='prodamus';
    checkout.paid_content=prodamusDelivery==='platform'?PLATFORM_ACCESS_NOTICE:tariff==='basic'
      ? 'Базовый тариф клуба «Фабрика заготовок». Вступить в закрытый Telegram-клуб после оплаты: '+PUBLIC_URL+'/access/basic/'+checkout.order_id
      : buildPremiumPaidContent(PUBLIC_URL,email,premiumPasswordForOrder(checkout.order_id,process.env.AUTH_CREDENTIAL_KEY));
    res.set('Cache-Control','no-store').json(checkout);
  }catch(error){next(error);}
});
app.use('/api/auth',(req,res,next)=>{res.set('Cache-Control','no-store');next();});
app.post('/api/checkout/direct',async(req,res,next)=>{
  const orderId=String(req.body?.orderId||'');
  const email=normalizeEmail(req.body?.email);
  if(orderId.length>180||!/^fz[34]-[bp]-/.test(orderId)||email.length>254)
    return res.status(400).json({message:'Повторно откройте форму покупки'});
  try{
    const saved=await pool.query(
      'SELECT r.tariff,o.buyer_name FROM club_checkout_consent_receipts r LEFT JOIN club_checkout_orders o ON o.order_id=r.order_id WHERE r.order_id=$1 AND r.buyer_email=$2',
      [orderId,email]);
    if(!saved.rowCount)return res.status(404).json({message:'Заказ не найден. Повторно откройте форму покупки'});
    if(cloudConfig.enabled){
      const cloudOrder=await cloudStore.getOrder(orderId);
      if(cloudOrder)return res.status(409).json({message:'Этот заказ создан для CloudPayments. Используйте исходный переход к оплате'});
    }
    const tariff=saved.rows[0].tariff;
    const checkout=restoreCheckout(orderId,process.env.AUTH_CREDENTIAL_KEY,email,saved.rows[0].buyer_name);
    if(!checkout||((tariff==='premium')!==/^fz[34]-p-/.test(orderId)))
      return res.status(400).json({message:'Не удалось проверить заказ'});
    const paid=await pool.query('SELECT 1 FROM club_webhook_events WHERE event_id IN ($1,$2)',[sha256('prodamus:'+orderId),sha256('cloudpayments:'+orderId)]);
    if(paid.rowCount)return res.status(409).json({message:'Оплата этого заказа уже подтверждена. Проверьте письмо с доступом'});
    if(tariff==='premium'){
      const existing=await pool.query("SELECT 1 FROM club_users WHERE (email=$1 OR login_email=$1) AND password_hash IS NOT NULL LIMIT 1",[email]);
      if(existing.rowCount)return res.status(409).json({message:'У вас уже есть доступ по этому email. Войдите в клуб или обратитесь в службу заботы'});
    }
    if(!process.env.PRODAMUS_SECRET_KEY||(tariff==='basic'&&
      (process.env.BASIC_CHECKOUT_ENABLED!=='true'||!basicInviteUrl())))
      return res.status(503).json({message:'Прямой переход к оплате пока недоступен'});
    const platformOrder=mailRuntimeEnabled?await getProdamusMailOrder(pool,orderId):null;
    checkout.paid_content=platformOrder&&platformOrder.access_delivery_provider!=='prodamus'?PLATFORM_ACCESS_NOTICE:tariff==='basic'
      ? 'Базовый тариф клуба «Фабрика заготовок». Вступить в закрытый Telegram-клуб после оплаты: '+PUBLIC_URL+'/access/basic/'+orderId
      : buildPremiumPaidContent(PUBLIC_URL,email,premiumPasswordForOrder(orderId,process.env.AUTH_CREDENTIAL_KEY));
    res.set('Cache-Control','no-store').json(buildDirectPaymentForm(checkout,
      payload=>prodamusSign(payload,process.env.PRODAMUS_SECRET_KEY)));
  }catch(error){next(error);}
});
const failedLogins=new Map();
app.get('/api/auth/me',requireAuth,(req,res)=>res.json({email:req.user.email,name:req.user.name,tariff:req.user.tariff,purchaseAt:req.user.purchase_at,accessUntil:req.user.access_until}));
app.use('/api/pdfs',createPdfRouter({
  catalog:pdfCatalog,
  authorize:findSession,
  onFailure:()=>console.error('PDF_STORAGE_UNAVAILABLE'),
}));
app.use('/api/podcasts',createPodcastRouter({
  catalog:podcastCatalog,
  authorize:findSession,
  onFailure:()=>console.error('PODCAST_STORAGE_UNAVAILABLE'),
}));
app.post('/api/auth/login',express.urlencoded({extended:false,limit:'8kb'}),async(req,res,next)=>{
  res.set('Cache-Control','no-store');
  const formLogin=req.is('application/x-www-form-urlencoded');
  const fail=(status,message)=>formLogin
    ?res.status(status).type('html').send(renderLoginPage(message,normalizeEmail(req.body?.email)))
    :res.status(status).json({message});
  if(formLogin&&req.get('Origin')){
    try{
      const origin=new URL(req.get('Origin'));
      if(origin.origin!==new URL(PUBLIC_URL).origin&&origin.host!==req.get('host'))return fail(403,'Откройте форму входа на сайте клуба');
    }catch{return fail(403,'Откройте форму входа на сайте клуба');}
  }
  const email=normalizeEmail(req.body?.email);const password=String(req.body?.password||'');
  if(email.length>254||password.length>256)return fail(400,'Неверный email или пароль');
  if(!email||!password)return fail(400,'Введите email и пароль');
  try{
    if(failedLogins.size>10000){for(const [oldKey,value] of failedLogins){if(value.until<Date.now())failedLogins.delete(oldKey);}if(failedLogins.size>10000)failedLogins.clear();}
    const key=req.ip+':'+email;const record=failedLogins.get(key);
    if(record?.until>Date.now()&&record.count>=10)return fail(429,'Слишком много попыток. Повторите вход через 15 минут');
    const result=await pool.query("SELECT email,name,password_hash,tariff,purchase_at,access_until FROM club_users WHERE email=$1 AND status='active' AND tariff='premium' AND (access_until IS NULL OR access_until>now())",[email]);
    let user=result.rows[0];
    let authenticated=user&&await verifyPassword(password,user.password_hash);
    if(!authenticated){
      const purchased=await pool.query("SELECT email,login_email,name,password_hash,tariff,purchase_at,access_until FROM club_users WHERE login_email=$1 AND password_tag=$2 AND status='active' AND tariff='premium' AND (access_until IS NULL OR access_until>now()) LIMIT 1",[email,sha256('club-order-password:'+password)]);
      user=purchased.rows[0];
      authenticated=user&&await verifyPassword(password,user.password_hash);
    }
    if(!authenticated){
      const current=failedLogins.get(key);
      failedLogins.set(key,{count:(current?.until>Date.now()?current.count:0)+1,until:Date.now()+15*60000});
      const incident='L-'+crypto.randomBytes(4).toString('hex').toUpperCase();
      let activePasswordTags=[],hasActiveAccount=null,accountLookupSucceeded=false;
      try{
        const known=await pool.query("SELECT password_tag FROM club_users WHERE (email=$1 OR login_email=$1) AND status='active' AND tariff='premium' AND (access_until IS NULL OR access_until>now()) LIMIT 20",[email]);
        activePasswordTags=known.rows.map(row=>row.password_tag);
        hasActiveAccount=known.rowCount>0;
        accountLookupSucceeded=true;
      }catch{}
      const diagnostic=describeRejectedLogin({email,password,activePasswordTags});
      const metadata={event:'club_login_rejected',incident,
        emailKey:emailDiagnosticKey(email,credentialKey()),formLogin:Boolean(formLogin),
        accountLookupSucceeded,hasActiveAccount,...diagnostic};
      try{
        await pool.query('INSERT INTO club_login_diagnostics (incident,metadata) VALUES ($1,$2::jsonb)',[incident,JSON.stringify(metadata)]);
      }catch{
        console.warn(JSON.stringify({event:'club_login_diagnostic_storage_unavailable',incident}));
      }
      console.warn(JSON.stringify(metadata));
      return fail(401,'Неверный email или пароль. '+rejectedLoginHint(diagnostic)+' Код проверки: '+incident);
    }
    failedLogins.delete(key);
    const sessionToken=randomToken();
    await pool.query("INSERT INTO club_sessions (token_hash,email,expires_at) VALUES ($1,$2,now()+($3 * interval '1 day'))",[sha256(sessionToken),user.email,SESSION_DAYS]);
    res.setHeader('Set-Cookie',cookieHeader('club_session',sessionToken,SESSION_DAYS*86400));
    if(formLogin)return res.redirect(303,'/club');
    res.json({email:user.login_email||user.email,name:user.name,tariff:user.tariff,purchaseAt:user.purchase_at,accessUntil:user.access_until});
  }catch(error){next(error);}
});
app.post('/api/auth/logout',async(req,res,next)=>{try{const raw=parseCookies(req.headers.cookie).club_session;if(raw)await pool.query('DELETE FROM club_sessions WHERE token_hash=$1',[sha256(raw)]);res.setHeader('Set-Cookie',clearCookieHeader('club_session'));res.json({ok:true});}catch(error){next(error);}});
async function deliverPendingCredentials(email){
  const claim=await pool.query("UPDATE club_users SET credential_claimed_at=now() WHERE email=$1 AND credential_email_ciphertext IS NOT NULL AND (credential_claimed_at IS NULL OR credential_claimed_at<now()-interval '2 minutes') RETURNING credential_email_ciphertext",[email]);
  if(!claim.rowCount){
    const pending=await pool.query('SELECT credential_email_ciphertext FROM club_users WHERE email=$1',[email]);
    if(pending.rows[0]?.credential_email_ciphertext)throw new Error('Credential email is being sent; retry webhook');
    return;
  }
  const ciphertext=claim.rows[0].credential_email_ciphertext;
  try{
    await pool.query(`INSERT INTO club_admin_credentials(user_key,password_ciphertext) VALUES($1,$2)
      ON CONFLICT(user_key) DO UPDATE SET password_ciphertext=EXCLUDED.password_ciphertext,updated_at=now()`,[email,ciphertext]);
    await sendCredentialsEmail(email,decryptPassword(ciphertext),PUBLIC_URL);
    await pool.query("UPDATE club_users SET credential_email_ciphertext=NULL,credential_claimed_at=NULL,welcome_email_sent_at=now() WHERE email=$1 AND credential_email_ciphertext=$2",[email,ciphertext]);
  }catch(error){
    await pool.query('UPDATE club_users SET credential_claimed_at=NULL WHERE email=$1 AND credential_email_ciphertext=$2',[email,ciphertext]).catch(console.error);
    throw error;
  }
}
app.post('/api/webhooks/prodamus',upload.any(),async(req,res,next)=>{
  try{
    if(!process.env.PRODAMUS_SECRET_KEY)return res.status(503).send('Webhook is not configured');
    const payload=normalizeWebhookBody(req.body);
    const receivedSign=req.get('Sign');
    const expectedSign=prodamusSign(payload,process.env.PRODAMUS_SECRET_KEY);
    if(!/^[0-9a-f]{64}$/i.test(receivedSign||'')||!safeEqualHex(receivedSign.toLowerCase(),expectedSign))return res.status(400).send('Invalid signature');
    if(process.env.PRODAMUS_SYS&&String(payload.sys||'')!==process.env.PRODAMUS_SYS)return res.status(400).send('Invalid integration code');
    // Preserve production history observation without letting it acknowledge,
    // fulfill, block, or send mail for the underlying payment.
    if(adminEnabled)res.once('finish',()=>{
      if(res.statusCode!==200)return;
      try{
        const owned=identifyCheckout(payload,process.env.AUTH_CREDENTIAL_KEY);
        if(!['external','invalid'].includes(owned.kind))
          historyStore.observeProdamus(payload,owned).catch(()=>console.error('CLUB_HISTORY_NOTICE_UNAVAILABLE'));
      }catch{console.error('CLUB_HISTORY_NOTICE_UNAVAILABLE');}
    });
    const paymentStatus=String(payload.payment_status||'').toLowerCase();
    const checkout=identifyCheckout(payload,process.env.AUTH_CREDENTIAL_KEY);
    if(checkout.kind==='external')return res.status(200).send('ok');
    if(checkout.kind==='invalid')return res.status(422).send('Unexpected site order');
    const email=normalizeEmail(payload.customer_email);
    const orderId=String(payload.order_num||payload.order_id||'').trim();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!orderId)return res.status(422).send('customer_email and order_id are required');
    const platformOrder=mailRuntimeEnabled?await getProdamusMailOrder(pool,orderId):null;
    if(paymentStatus!=='success'){
      if(platformOrder){
        if(platformOrder.buyer_email!==email||Number(platformOrder.amount_cents)!==cents(payload.sum))
          return res.status(422).send('Payment does not match the saved order');
        const type=paymentStatus==='order_canceled'?'cancel':paymentStatus==='order_denied'?'fail':'unknown';
        await cloudStore.recordProviderEvent({orderId,provider:'prodamus',type,
          status:type==='cancel'?'canceled':type==='fail'?'failed':'unknown',
          transactionId:String(payload.order_id||''),amountCents:cents(payload.sum),currency:'RUB',
          eventTime:String(payload.date||'')});
      }
      return res.status(200).send('ok');
    }
    let savedName=null;
    if(checkout.requiresSavedName){
      const order=await pool.query('SELECT buyer_name FROM club_checkout_orders WHERE order_id=$1 AND buyer_email=$2',[orderId,email]);
      if(!order.rowCount)return res.status(422).send('Checkout name not found');
      savedName=order.rows[0].buyer_name;
    }
    const eventId=sha256('prodamus:'+orderId);
    if(platformOrder){
      await fulfillProdamusMailOrder(pool,orderId,payload,{
        async grantPremium(client,order){
          const userKey='order:'+order.order_id;
          const password=premiumPasswordForOrder(order.order_id,process.env.AUTH_CREDENTIAL_KEY);
          const matches=(await client.query(`SELECT email,password_hash,status,tariff,
            (access_until IS NULL OR access_until>now()) AS valid FROM club_users
            WHERE email=$1 OR login_email=$2 FOR UPDATE`,[userKey,order.buyer_email])).rows;
          if(matches.some(user=>user.email!==userKey||user.status!=='active'||user.tariff!=='premium'||!user.valid))
            return {review:true};
          if(matches.length&&!await verifyPassword(password,matches[0].password_hash))return {review:true};
          if(!matches.length)await client.query(`INSERT INTO club_users
            (email,login_email,password_tag,name,password_hash,tariff,access_until,purchase_at,status)
            VALUES($1,$2,$3,$4,$5,'premium',NULL,now(),'active')`,
          [userKey,order.buyer_email,sha256('club-order-password:'+password),order.buyer_name,await hashPassword(password)]);
          return {userKey,ciphertext:encryptPassword(password)};
        }
      });
      return res.status(200).send('ok');
    }
    if(checkout.tariff==='basic'){
      await pool.query('INSERT INTO club_webhook_events (event_id,payload) VALUES ($1,$2::jsonb) ON CONFLICT (event_id) DO NOTHING',[eventId,JSON.stringify({tariff:'basic',source:'site',handledBy:'prodamus'})]);
      return res.status(200).send('ok');
    }
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[email]);
      const auditPayload=checkout.orderId
        ? {source:'site',tariff:'premium',orderNum:orderId,providerOrderId:payload.order_id,customerEmail:email,sum:payload.sum}
        : payload;
      const event=await client.query('INSERT INTO club_webhook_events (event_id,payload) VALUES ($1,$2::jsonb) ON CONFLICT (event_id) DO NOTHING RETURNING event_id',[eventId,JSON.stringify(auditPayload)]);
      if(event.rowCount){
        const found=await client.query('SELECT password_hash,welcome_email_sent_at,credential_email_ciphertext FROM club_users WHERE email=$1 FOR UPDATE',[email]);
        const existing=found.rows[0];
        if(checkout.orderId){
          const password=premiumPasswordForOrder(checkout.orderId,process.env.AUTH_CREDENTIAL_KEY);
          const passwordHash=await hashPassword(password);
          const customerName=checkout.requiresSavedName?savedName:(payload.customer_name?String(payload.customer_name).trim():null);
          await client.query("INSERT INTO club_users (email,login_email,password_tag,name,password_hash,tariff,access_until,purchase_at,status) VALUES ($1,$2,$3,$4,$5,'premium',NULL,now(),'active') ON CONFLICT (email) DO NOTHING",['order:'+checkout.orderId,email,sha256('club-order-password:'+password),customerName,passwordHash]);
        }else{
        let passwordHash=existing?.password_hash||null;
        let ciphertext=existing?.credential_email_ciphertext||null;
        let sentAt=existing?.welcome_email_sent_at||null;
        if(!passwordHash||(!sentAt&&!ciphertext)){
          const password=generatePassword();
          passwordHash=await hashPassword(password);
          ciphertext=encryptPassword(password);
          sentAt=null;
        }
        const customerName=payload.customer_name?String(payload.customer_name).trim():null;
        await client.query("INSERT INTO club_users (email,name,password_hash,credential_email_ciphertext,tariff,access_until,purchase_at,welcome_email_sent_at,status) VALUES ($1,$2,$3,$4,'premium',NULL,now(),$5,'active') ON CONFLICT (email) DO UPDATE SET name=COALESCE(EXCLUDED.name,club_users.name),password_hash=EXCLUDED.password_hash,credential_email_ciphertext=EXCLUDED.credential_email_ciphertext,tariff='premium',access_until=NULL,purchase_at=now(),welcome_email_sent_at=EXCLUDED.welcome_email_sent_at,status='active',updated_at=now()",[email,customerName,passwordHash,ciphertext,sentAt]);
        }
      }
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK').catch(console.error);throw error;}
    finally{client.release();}
    if(!checkout.orderId)await deliverPendingCredentials(email);
    return res.status(200).send('ok');
  }catch(error){next(error);}
});

app.get('/access/basic/:orderId',async(req,res,next)=>{
  try{
    const orderId=String(req.params.orderId||'');
    if(!/^fz[34]-b-[a-z0-9-]{45,125}$/.test(orderId))return res.status(404).send('Доступ пока недоступен');
    const event=await pool.query("SELECT 1 FROM club_webhook_events WHERE event_id IN ($1,$2) AND payload->>'tariff'='basic' LIMIT 1",[sha256('prodamus:'+orderId),sha256('cloudpayments:'+orderId)]);
    if(!event.rowCount)return res.status(404).send('Оплата пока не подтверждена. Если вы уже оплатили, попробуйте открыть ссылку через несколько минут.');
    const invite=basicInviteUrl();
    if(!invite)return res.status(503).send('Доступ временно недоступен. Обратитесь в службу заботы.');
    res.set('Cache-Control','no-store').redirect(302,invite);
  }catch(error){next(error);}
});

// The public page contains only landing and login markup, never members' recipes or data.
const sourceMemberHtml=rewritePdfLinks(await readFile(new URL('./index.html',import.meta.url),'utf8'),pdfCatalog);
// /club is already authorized on the server. Never initially show the sales
// landing while the browser restores its profile or if its script fails.
const memberHtml=sourceMemberHtml
  .replace('<div class="screen active" id="screen-landing">','<div class="screen" id="screen-landing">')
  .replace('<div class="screen" id="screen-dashboard">','<div class="screen active" id="screen-dashboard">');
const memberMarker='<!-- ═══════════ ЭКРАН: ЛИЧНЫЙ КАБИНЕТ (ГЛАВНАЯ) ═══════════ -->';
if(!memberHtml.includes(memberMarker))throw new Error('Public page boundary not found');
const guestHtml=sourceMemberHtml.split(memberMarker)[0]+"<div id=\"toast\" class=\"toast\" role=\"status\"></div>\n<script>\nfunction showScreen(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById('screen-'+id).classList.add('active');window.scrollTo(0,0);}\nfunction toast(message,error){const node=document.getElementById('toast');node.textContent=message;node.className='toast show'+(error?' err':'');setTimeout(()=>node.className='toast',4000);}\nasync function doLogin(){\n  const email=document.getElementById('loginEmail').value.trim().toLowerCase();\n  const password=document.getElementById('loginPassword').value;\n  if(!email||!password)return toast('Введите email и пароль из письма',true);\n  const button=document.querySelector('#screen-login .login-btn');button.disabled=true;\n  try{\n    const response=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});\n    const data=await response.json();\n    if(!response.ok)throw new Error(data.message||'Не удалось войти');\n    location.assign('/club');\n  }catch(error){toast(error.message||'Не удалось войти',true);button.disabled=false;}\n}\nif(new URLSearchParams(location.search).has('paid')){showScreen('login');toast('Если оплата прошла, письмо с данными для входа придёт на вашу почту.');}\nelse if(new URLSearchParams(location.search).has('login'))showScreen('login');\n</script></body></html>";
const loginHtml=guestHtml
  .replace('<div class="screen active" id="screen-landing">','<div class="screen" id="screen-landing">')
  .replace('<div class="screen" id="screen-login">','<div class="screen active" id="screen-login">');
function renderLoginPage(message='',email=''){
  const escape=value=>String(value).replace(/[&<>"]/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[char]));
  let html=loginHtml;
  if(email)html=html.replace('id="loginEmail" name="email"',
    'id="loginEmail" name="email" value="'+escape(String(email).slice(0,254))+'"');
  if(message)html=html.replace('<p class="login-note" id="loginMessage">Данные для входа придут на почту после успешной оплаты.</p>',
    '<p class="login-note" id="loginMessage" role="alert">'+escape(message)+'</p>');
  return html;
}
app.get('/api/auth/login',(req,res)=>res.set('Cache-Control','no-store').redirect(303,'/?login=1'));
app.get('/vera-hero.png',(req,res)=>res.sendFile(fileURLToPath(new URL('./vera-hero.png',import.meta.url))));
app.get(['/', '/index.html'],async(req,res,next)=>{
  try{
    res.set('Cache-Control','no-store');
    if(Object.hasOwn(req.query,'login')||Object.hasOwn(req.query,'paid'))return res.set('Cache-Control','no-store').type('html').send(renderLoginPage('',normalizeEmail(req.query.email)));
    if(await findSession(req))return res.redirect('/club');
    res.type('html').send(guestHtml);
  }catch(error){next(error);}
});
const startMaterialNames=new Set(['revision','menu','rules','organization']);
app.get('/api/start-materials/:name.txt',async(req,res,next)=>{
  try{
    if(!await findSession(req))return res.status(401).json({message:'Войдите в клуб, чтобы открыть материал'});
    if(!startMaterialNames.has(req.params.name))return res.status(404).end();
    res.set('Cache-Control','private, no-store').type('text/plain; charset=utf-8');
    res.sendFile(fileURLToPath(new URL(`./start-materials/${req.params.name}.txt`,import.meta.url)));
  }catch(error){next(error);}
});
const textMaterialNames=new Set(['nutrition-calories','earning-preparations']);
app.get('/api/materials/:name.txt',async(req,res,next)=>{
  try{
    if(!await findSession(req))return res.status(401).json({message:'Войдите в клуб, чтобы открыть материал'});
    if(!textMaterialNames.has(req.params.name))return res.status(404).end();
    res.set('Cache-Control','private, no-store').type('text/plain; charset=utf-8');
    res.sendFile(fileURLToPath(new URL(`./materials/${req.params.name}.txt`,import.meta.url)));
  }catch(error){next(error);}
});
const hematologistParts=new Set(['1','2','3']);
app.get('/api/hematologist/:part.txt',async(req,res,next)=>{
  try{
    if(!await findSession(req))return res.status(401).json({message:'Войдите в клуб, чтобы открыть материал'});
    if(!hematologistParts.has(req.params.part))return res.status(404).end();
    res.set('Cache-Control','private, no-store').type('text/plain; charset=utf-8');
    res.sendFile(fileURLToPath(new URL(`./health/hematologist-${req.params.part}.txt`,import.meta.url)));
  }catch(error){next(error);}
});
app.get(['/health/hematologist.js','/health/hematologist.jpg','/health/nutrition-yana.jpg'],async(req,res,next)=>{
  try{
    if(!await findSession(req))return res.status(401).end();
    res.set('Cache-Control','private, no-store');
    res.sendFile(fileURLToPath(new URL(`.${req.path}`,import.meta.url)));
  }catch(error){next(error);}
});
app.get('/club',async(req,res,next)=>{
  try{
    const user=await findSession(req);
    if(!user)return res.redirect('/?login=1');
    const adminLink=adminEnabled&&await adminStore.isAdmin(user.user_key);
    const html=adminLink?memberHtml.replace(
      '    <button class="login-btn" onclick="showScreen(\'dashboard\')">',
      '    <a class="login-btn" href="/admin" style="display:block;text-align:center;text-decoration:none">Оплаты и письма</a>\n    <button class="login-btn" onclick="showScreen(\'dashboard\')">'):memberHtml;
    res.set('Cache-Control','no-store').type('html').send(html);
  }catch(error){next(error);}
});
app.use((error,req,res,next)=>{
  if(error instanceof CloudPaymentsError)return res.status(error.status).json({message:error.message});
  console.error(error);if(res.headersSent)return next(error);res.status(500).json({message:'Внутренняя ошибка сервера'});
});
await initDatabase();
if(adminEnabled&&mailRuntimeEnabled){
  let reconciling=false;
  const syncHistory=async()=>{
    if(reconciling)return;reconciling=true;
    try{await historyStore.reconcile();}
    catch{console.error('CLUB_HISTORY_RECONCILIATION_UNAVAILABLE');}
    finally{reconciling=false;}
  };
  setTimeout(syncHistory,1000).unref();
  setInterval(syncHistory,60000).unref();
}
for(const statement of CHECKOUT_PROVIDER_SCHEMA)await pool.query(statement);
await adminStore.initializeCheckoutProvider(initialCheckoutProvider);
if(mailRuntimeEnabled&&(cloudConfig.enabled||prodamusWorkerEnabled)){
  let draining=false;
  const drain=async()=>{
    if(draining)return;draining=true;
    try{
      await drainAccessMail(pool,async(order,mail)=>{
        if(order.tariff==='basic')return sendBasicAccessEmail(order.buyer_email,PUBLIC_URL+'/access/basic/'+order.order_id);
        const password=decryptPassword(mail.password_ciphertext);
        const user=await pool.query('SELECT password_hash,login_email,status,tariff,(access_until IS NULL OR access_until>now()) AS valid FROM club_users WHERE email=$1',[mail.user_key]);
        if(!user.rows[0]||!user.rows[0].valid||user.rows[0].status!=='active'||user.rows[0].tariff!=='premium'||
          !await verifyPassword(password,user.rows[0].password_hash))
          throw new CloudPaymentsError('Пароль изменён; требуется проверка письма',409);
        // Support may correct a login email without rewriting signed payment history.
        const recipient=normalizeEmail(user.rows[0].login_email||order.buyer_email);
        if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))
          throw new CloudPaymentsError('Email изменён; требуется проверка письма',409);
        return sendCredentialsEmail(recipient,password,PUBLIC_URL);
      },10,[...(cloudConfig.enabled?['cloudpayments']:[]),...(prodamusWorkerEnabled?['prodamus']:[])]);
    }catch{console.error('CLUB_ACCESS_MAIL_QUEUE_UNAVAILABLE');}
    finally{draining=false;}
  };
  await drain();
  setInterval(drain,30000).unref();
  let monitoring=false;
  const monitor=async()=>{
    if(monitoring)return;monitoring=true;
    try{
      await pollMailStatuses(pool);
      if(adminEnabled&&alertsConfigured)
        await notifyMailAttention(pool,data=>sendAdminMailAlert(process.env.CLUB_ADMIN_ALERT_EMAIL,PUBLIC_URL,data));
    }catch{console.error('CLUB_MAIL_MONITOR_UNAVAILABLE');}
    finally{monitoring=false;}
  };
  await monitor();
  setInterval(monitor,60000).unref();
}
app.listen(PORT,'0.0.0.0',()=>console.log('Club server listening on '+PORT));

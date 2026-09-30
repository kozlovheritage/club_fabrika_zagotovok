import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import express from 'express';
import multer from 'multer';
import pg from 'pg';
import {sendCredentialsEmail} from './email.mjs';
import {createCheckout,identifyCheckout,premiumPasswordForOrder,quotePrice} from './checkout.mjs';

const {Pool}=pg;
const scryptAsync=promisify(crypto.scrypt);
const app=express();
const upload=multer({limits:{fields:200,fieldSize:1024*1024}});
const PORT=Number(process.env.PORT||3000);
const PUBLIC_URL=(process.env.PUBLIC_URL||'').replace(/\/$/,'');
const SESSION_DAYS=Number(process.env.SESSION_DAYS||30);
const COOKIE_SECURE=process.env.COOKIE_SECURE!=='false'&&process.env.NODE_ENV==='production';
const SALES_ORIGINS=(process.env.SALES_ORIGINS||'https://sales-club-fabrika-zagotovok-kozlovheritage.onreza.app').split(',').map(x=>x.trim()).filter(Boolean);
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==='false'?false:{rejectUnauthorized:false}});
if(!process.env.DATABASE_URL)throw new Error('DATABASE_URL is required');
if(!PUBLIC_URL||!/^https:\/\//.test(PUBLIC_URL))throw new Error('PUBLIC_URL must be an HTTPS site address');
credentialKey();

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
async function initDatabase(){for(const statement of schema)await pool.query(statement);}
async function findSession(req){const raw=parseCookies(req.headers.cookie).club_session;if(!raw)return null;const result=await pool.query("SELECT COALESCE(u.login_email,u.email) AS email,u.name,u.tariff,u.purchase_at,u.access_until FROM club_sessions s JOIN club_users u ON u.email=s.email WHERE s.token_hash=$1 AND s.expires_at>now() AND u.status='active' AND u.tariff='premium' AND (u.access_until IS NULL OR u.access_until>now())",[sha256(raw)]);return result.rows[0]||null;}
async function requireAuth(req,res,next){try{const user=await findSession(req);if(!user)return res.status(401).json({message:'Сессия истекла'});req.user=user;next();}catch(error){next(error);}}

app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:true,limit:'1mb'}));
app.get('/api/health',(req,res)=>res.json({ok:true}));
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
  const tariff=req.body?.tariff;
  if(tariff!=='basic'&&tariff!=='premium')return res.status(400).json({message:'Неизвестный тариф'});
  const email=normalizeEmail(req.body?.email);
  if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({message:'Укажите email для письма с доступом'});
  let quote;
  try{quote=quotePrice(tariff,req.body?.promo??'');}
  catch(error){return res.status(400).json({message:error.message});}
  if(tariff==='basic'&&process.env.BASIC_CHECKOUT_ENABLED!=='true')return res.status(503).json({message:'Оплата базового тарифа пока недоступна'});
  const invite=tariff==='basic'&&basicInviteUrl();
  if(tariff==='basic'&&!invite)return res.status(503).json({message:'Доступ в Telegram-клуб пока не настроен'});
  try{
    if(tariff==='premium'){
      const existing=await pool.query("SELECT 1 FROM club_users WHERE (email=$1 OR login_email=$1) AND password_hash IS NOT NULL LIMIT 1",[email]);
      if(existing.rowCount)return res.status(409).json({message:'У вас уже есть доступ по этому email. Войдите в клуб или обратитесь в службу заботы, если забыли пароль.'});
    }
    const checkout=createCheckout(tariff,process.env.AUTH_CREDENTIAL_KEY,process.env,email,quote.codes.join(' '));
    if(!checkout)return res.status(503).json({message:'Оплата пока недоступна'});
    checkout.paid_content=tariff==='basic'
      ? 'Базовый тариф клуба «Фабрика заготовок». Вступить в закрытый Telegram-клуб после оплаты: '+PUBLIC_URL+'/access/basic/'+checkout.order_id
      : 'Расширенный тариф клуба «Фабрика заготовок». Личный кабинет: '+PUBLIC_URL+
        '/?login=1\nEmail для входа: '+email+
        '\nПароль: '+premiumPasswordForOrder(checkout.order_id,process.env.AUTH_CREDENTIAL_KEY)+
        '\nСохраните это письмо: данные для входа действуют бессрочно.';
    res.set('Cache-Control','no-store').json(checkout);
  }catch(error){next(error);}
});
app.use('/api/auth',(req,res,next)=>{res.set('Cache-Control','no-store');next();});
const failedLogins=new Map();
app.get('/api/auth/me',requireAuth,(req,res)=>res.json({email:req.user.email,name:req.user.name,tariff:req.user.tariff,purchaseAt:req.user.purchase_at,accessUntil:req.user.access_until}));
app.post('/api/auth/login',async(req,res,next)=>{
  const email=normalizeEmail(req.body?.email);const password=String(req.body?.password||'');
  if(email.length>254||password.length>256)return res.status(400).json({message:'Неверный email или пароль'});
  if(!email||!password)return res.status(400).json({message:'Введите email и пароль'});
  try{
    if(failedLogins.size>10000){for(const [oldKey,value] of failedLogins){if(value.until<Date.now())failedLogins.delete(oldKey);}if(failedLogins.size>10000)failedLogins.clear();}
    const key=req.ip+':'+email;const record=failedLogins.get(key);
    if(record?.until>Date.now()&&record.count>=10)return res.status(429).json({message:'Слишком много попыток. Повторите вход через 15 минут'});
    const result=await pool.query("SELECT email,name,password_hash,tariff,purchase_at,access_until FROM club_users WHERE email=$1 AND status='active' AND tariff='premium' AND (access_until IS NULL OR access_until>now())",[email]);
    let user=result.rows[0];
    let authenticated=user&&await verifyPassword(password,user.password_hash);
    if(!authenticated){
      const purchased=await pool.query("SELECT email,login_email,name,password_hash,tariff,purchase_at,access_until FROM club_users WHERE login_email=$1 AND password_tag=$2 AND status='active' AND tariff='premium' AND (access_until IS NULL OR access_until>now()) LIMIT 1",[email,sha256('club-order-password:'+password)]);
      user=purchased.rows[0];
      authenticated=user&&await verifyPassword(password,user.password_hash);
    }
    if(!authenticated){const current=failedLogins.get(key);failedLogins.set(key,{count:(current?.until>Date.now()?current.count:0)+1,until:Date.now()+15*60000});return res.status(401).json({message:'Неверный email или пароль'});}
    failedLogins.delete(key);
    const sessionToken=randomToken();
    await pool.query("INSERT INTO club_sessions (token_hash,email,expires_at) VALUES ($1,$2,now()+($3 * interval '1 day'))",[sha256(sessionToken),user.email,SESSION_DAYS]);
    res.setHeader('Set-Cookie',cookieHeader('club_session',sessionToken,SESSION_DAYS*86400));
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
    if(String(payload.payment_status||'').toLowerCase()!=='success')return res.status(200).send('ok');
    const checkout=identifyCheckout(payload,process.env.AUTH_CREDENTIAL_KEY);
    if(checkout.kind==='external')return res.status(200).send('ok');
    if(checkout.kind==='invalid')return res.status(422).send('Unexpected site order');
    const email=normalizeEmail(payload.customer_email);
    const orderId=String(payload.order_num||payload.order_id||'').trim();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||!orderId)return res.status(422).send('customer_email and order_id are required');
    const eventId=sha256('prodamus:'+orderId);
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
          const customerName=payload.customer_name?String(payload.customer_name).trim():null;
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
    if(!/^fz3-b-[a-z0-9-]{45,125}$/.test(orderId))return res.status(404).send('Доступ пока недоступен');
    const event=await pool.query("SELECT 1 FROM club_webhook_events WHERE event_id=$1 AND payload->>'tariff'='basic' LIMIT 1",[sha256('prodamus:'+orderId)]);
    if(!event.rowCount)return res.status(404).send('Оплата пока не подтверждена. Если вы уже оплатили, попробуйте открыть ссылку через несколько минут.');
    const invite=basicInviteUrl();
    if(!invite)return res.status(503).send('Доступ временно недоступен. Обратитесь в службу заботы.');
    res.set('Cache-Control','no-store').redirect(302,invite);
  }catch(error){next(error);}
});

// The public page contains only landing and login markup, never members' recipes or data.
const memberHtml=await readFile(new URL('./index.html',import.meta.url),'utf8');
const memberMarker='<!-- ═══════════ ЭКРАН: ЛИЧНЫЙ КАБИНЕТ (ГЛАВНАЯ) ═══════════ -->';
if(!memberHtml.includes(memberMarker))throw new Error('Public page boundary not found');
const guestHtml=memberHtml.split(memberMarker)[0]+"<div id=\"toast\" class=\"toast\" role=\"status\"></div>\n<script>\nfunction showScreen(id){document.querySelectorAll('.screen').forEach(s=>s.classList.remove('active'));document.getElementById('screen-'+id).classList.add('active');window.scrollTo(0,0);}\nfunction toast(message,error){const node=document.getElementById('toast');node.textContent=message;node.className='toast show'+(error?' err':'');setTimeout(()=>node.className='toast',4000);}\nasync function doLogin(){\n  const email=document.getElementById('loginEmail').value.trim().toLowerCase();\n  const password=document.getElementById('loginPassword').value;\n  if(!email||!password)return toast('Введите email и пароль из письма',true);\n  const button=document.querySelector('#screen-login .login-btn');button.disabled=true;\n  try{\n    const response=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});\n    const data=await response.json();\n    if(!response.ok)throw new Error(data.message||'Не удалось войти');\n    location.assign('/club');\n  }catch(error){toast(error.message||'Не удалось войти',true);button.disabled=false;}\n}\nif(new URLSearchParams(location.search).has('paid')){showScreen('login');toast('Если оплата прошла, письмо с данными для входа придёт на вашу почту.');}\nelse if(new URLSearchParams(location.search).has('login'))showScreen('login');\n</script></body></html>";
app.get('/vera-hero.png',(req,res)=>res.sendFile(fileURLToPath(new URL('./vera-hero.png',import.meta.url))));
app.get(['/', '/index.html'],async(req,res,next)=>{
  try{
    res.set('Cache-Control','no-store');
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
const textMaterialNames=new Set(['nutrition-calories']);
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
app.get(['/health/hematologist.js','/health/hematologist.jpg'],async(req,res,next)=>{
  try{
    if(!await findSession(req))return res.status(401).end();
    res.set('Cache-Control','private, no-store');
    res.sendFile(fileURLToPath(new URL(`.${req.path}`,import.meta.url)));
  }catch(error){next(error);}
});
app.get('/club',async(req,res,next)=>{
  try{
    if(!await findSession(req))return res.redirect('/?login=1');
    res.set('Cache-Control','no-store').type('html').send(memberHtml);
  }catch(error){next(error);}
});
app.use((error,req,res,next)=>{console.error(error);if(res.headersSent)return next(error);res.status(500).json({message:'Внутренняя ошибка сервера'});});
await initDatabase();
app.listen(PORT,'0.0.0.0',()=>console.log('Club server listening on '+PORT));

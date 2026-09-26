import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import pg from 'pg';

const {Pool}=pg;
const app=express();
const upload=multer({limits:{fields:200,fieldSize:1024*1024}});
const PORT=Number(process.env.PORT||3000);
const PUBLIC_URL=(process.env.PUBLIC_URL||'').replace(/\/$/,'');
const ACCESS_DAYS=Number(process.env.ACCESS_DAYS||31);
const SESSION_DAYS=Number(process.env.SESSION_DAYS||30);
const AUTH_LINK_MINUTES=Number(process.env.AUTH_LINK_MINUTES||15);
const COOKIE_SECURE=process.env.COOKIE_SECURE!=='false'&&process.env.NODE_ENV==='production';
const DEFAULT_TARIFF=process.env.DEFAULT_TARIFF||'premium';
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSL==='false'?false:{rejectUnauthorized:false}});
if(!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

const schema=[
  "CREATE TABLE IF NOT EXISTS club_users (email TEXT PRIMARY KEY, name TEXT, tariff TEXT NOT NULL DEFAULT 'premium', access_until TIMESTAMPTZ NOT NULL, purchase_at TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS club_auth_links (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES club_users(email) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ)",
  "CREATE TABLE IF NOT EXISTS club_sessions (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL REFERENCES club_users(email) ON DELETE CASCADE, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())",
  "CREATE TABLE IF NOT EXISTS club_webhook_events (event_id TEXT PRIMARY KEY, payload JSONB NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now())"
];
function normalizeEmail(value){return String(value||'').trim().toLowerCase();}
function sha256(value){return crypto.createHash('sha256').update(value,'utf8').digest('hex');}
function randomToken(){return crypto.randomBytes(32).toString('base64url');}
function safeEqualHex(left,right){if(!left||!right||left.length!==right.length)return false;return crypto.timingSafeEqual(Buffer.from(left),Buffer.from(right));}
function sortAndStringify(value){
  if(Array.isArray(value))return value.map(sortAndStringify);
  if(value&&typeof value==='object')return Object.keys(value).sort().reduce((out,key)=>{out[key]=sortAndStringify(value[key]);return out;},{});
  return value===null||value===undefined?'':String(value);
}
function prodamusSign(payload,secret){
  const normalized=JSON.stringify(sortAndStringify(payload)).replace(/\//g,'\\/');
  return crypto.createHmac('sha256',secret).update(normalized,'utf8').digest('hex');
}
function setDeep(target,path,value){
  const parts=path.replace(/\]/g,'').split('[');let cursor=target;
  for(let i=0;i<parts.length;i+=1){
    const part=parts[i];if(!part||part==='__proto__'||part==='constructor'||part==='prototype')return;
    const last=i===parts.length-1;
    if(last){if(cursor[part]===undefined)cursor[part]=value;else if(Array.isArray(cursor[part]))cursor[part].push(value);else cursor[part]=[cursor[part],value];return;}
    const nextIsIndex=/^\d+$/.test(parts[i+1]);if(cursor[part]===undefined)cursor[part]=nextIsIndex?[]:{};cursor=cursor[part];
  }
}
function normalizeWebhookBody(body){
  if(!body||typeof body!=='object')return {};
  if(!Object.keys(body).some(key=>key.includes('[')))return body;
  const result={};Object.entries(body).forEach(([key,value])=>setDeep(result,key,value));return result;
}
function flattenProducts(products){if(!products)return [];return Array.isArray(products)?products:Object.values(products);}
function inferTariff(payload){
  const names=flattenProducts(payload.products).map(product=>String(product?.name||'').toLowerCase()).join(' ');
  if(/расшир|premium|премиум/.test(names))return 'premium';
  if(/базов|basic/.test(names))return 'basic';
  return DEFAULT_TARIFF;
}
function parseCookies(header){return String(header||'').split(';').reduce((out,part)=>{const index=part.indexOf('=');if(index<0)return out;out[part.slice(0,index).trim()]=decodeURIComponent(part.slice(index+1).trim());return out;},{});}
function cookieHeader(name,value,maxAge){return name+'='+encodeURIComponent(value)+'; Path=/; HttpOnly; SameSite=Lax; Max-Age='+maxAge+(COOKIE_SECURE?'; Secure':'');}
function clearCookieHeader(name){return name+'=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'+(COOKIE_SECURE?'; Secure':'');}
function publicUrl(req){return PUBLIC_URL||(req.protocol+'://'+req.get('host'));}
function escapeHtml(value){return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));}
async function sendMagicLink(email,link){
  if(process.env.AUTH_EMAIL_PROVIDER!=='resend'||!process.env.RESEND_API_KEY||!process.env.AUTH_FROM_EMAIL){
    if(process.env.NODE_ENV!=='production'){console.log('[auth] development magic link for '+email+': '+link);return;}
    throw new Error('Email provider is not configured');
  }
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+process.env.RESEND_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.AUTH_FROM_EMAIL,to:[email],subject:'Ссылка для входа в клуб «Фабрика заготовок»',text:'Войдите в клуб по ссылке: '+link+'\n\nСсылка действует 15 минут и одноразовая.',html:'<p>Войдите в клуб «Фабрика заготовок»:</p><p><a href="'+escapeHtml(link)+'">Открыть личный кабинет</a></p><p>Ссылка действует 15 минут и одноразовая.</p>'})});
  if(!response.ok)throw new Error('Email provider returned '+response.status);
}
async function initDatabase(){for(const statement of schema)await pool.query(statement);}
async function findSession(req){
  const raw=parseCookies(req.headers.cookie).club_session;if(!raw)return null;
  const result=await pool.query("SELECT u.email,u.name,u.tariff,u.purchase_at,u.access_until FROM club_sessions s JOIN club_users u ON u.email=s.email WHERE s.token_hash=$1 AND s.expires_at>now() AND u.status='active' AND u.access_until>now()",[sha256(raw)]);
  return result.rows[0]||null;
}
async function requireAuth(req,res,next){try{const user=await findSession(req);if(!user)return res.status(401).json({message:'Сессия истекла'});req.user=user;next();}catch(error){next(error);}}

app.use(express.json({limit:'1mb'}));
app.use(express.urlencoded({extended:true,limit:'1mb'}));
app.get('/api/health',(req,res)=>res.json({ok:true}));
app.get('/api/auth/me',requireAuth,(req,res)=>res.json({email:req.user.email,name:req.user.name,tariff:req.user.tariff,purchaseAt:req.user.purchase_at,accessUntil:req.user.access_until}));
app.post('/api/auth/request-link',async(req,res,next)=>{
  const email=normalizeEmail(req.body?.email);
  if(!email||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({message:'Введите корректный email'});
  try{
    const result=await pool.query("SELECT email FROM club_users WHERE email=$1 AND status='active' AND access_until>now()",[email]);
    if(result.rowCount){
      const rawToken=randomToken();
      await pool.query('DELETE FROM club_auth_links WHERE email=$1 OR expires_at<=now()',[email]);
      await pool.query("INSERT INTO club_auth_links (token_hash,email,expires_at) VALUES ($1,$2,now()+($3 * interval '1 minute'))",[sha256(rawToken),email,AUTH_LINK_MINUTES]);
      await sendMagicLink(email,publicUrl(req)+'/auth/verify?token='+encodeURIComponent(rawToken));
    }
    res.json({ok:true,message:'Если этот email есть среди оплативших, ссылка для входа уже отправлена на почту.'});
  }catch(error){next(error);}
});
app.post('/api/auth/logout',async(req,res,next)=>{try{const raw=parseCookies(req.headers.cookie).club_session;if(raw)await pool.query('DELETE FROM club_sessions WHERE token_hash=$1',[sha256(raw)]);res.setHeader('Set-Cookie',clearCookieHeader('club_session'));res.json({ok:true});}catch(error){next(error);}});
app.get('/auth/verify',async(req,res,next)=>{
  const rawToken=String(req.query.token||'');if(!rawToken)return res.redirect('/?auth=invalid');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const link=await client.query('SELECT email FROM club_auth_links WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE',[sha256(rawToken)]);
    if(!link.rowCount){await client.query('ROLLBACK');return res.redirect('/?auth=invalid');}
    await client.query('UPDATE club_auth_links SET used_at=now() WHERE token_hash=$1',[sha256(rawToken)]);
    const sessionToken=randomToken();
    await client.query("INSERT INTO club_sessions (token_hash,email,expires_at) VALUES ($1,$2,now()+($3 * interval '1 day'))",[sha256(sessionToken),link.rows[0].email,SESSION_DAYS]);
    await client.query('COMMIT');res.setHeader('Set-Cookie',cookieHeader('club_session',sessionToken,SESSION_DAYS*86400));res.redirect('/?auth=success');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});next(error);}finally{client.release();}
});
app.post('/api/webhooks/prodamus',upload.any(),async(req,res,next)=>{
  try{
    if(!process.env.PRODAMUS_SECRET_KEY)return res.status(503).send('Webhook is not configured');
    const payload=normalizeWebhookBody(req.body);const receivedSign=req.get('Sign')||req.get('sign');const expectedSign=prodamusSign(payload,process.env.PRODAMUS_SECRET_KEY);
    if(!receivedSign||!safeEqualHex(receivedSign.toLowerCase(),expectedSign))return res.status(400).send('Invalid signature');
    if(process.env.PRODAMUS_SYS&&String(payload.sys||'')!==String(process.env.PRODAMUS_SYS))return res.status(400).send('Invalid integration code');
    const email=normalizeEmail(payload.customer_email);const paymentStatus=String(payload.payment_status||'').toLowerCase();
    if(paymentStatus==='success'&&!email)return res.status(422).send('customer_email is required');
    const eventId=sha256(JSON.stringify(sortAndStringify({order_id:payload.order_id,order_num:payload.order_num,date:payload.date,attempt:payload.attempt,customer_email:email,payment_status:paymentStatus})));
    const inserted=await pool.query('INSERT INTO club_webhook_events (event_id,payload) VALUES ($1,$2::jsonb) ON CONFLICT (event_id) DO NOTHING RETURNING event_id',[eventId,JSON.stringify(payload)]);
    if(!inserted.rowCount||paymentStatus!=='success')return res.status(200).send('ok');
    const previous=await pool.query('SELECT access_until FROM club_users WHERE email=$1',[email]);const now=Date.now();const previousUntil=previous.rows[0]?.access_until?new Date(previous.rows[0].access_until).getTime():0;const accessUntil=new Date(Math.max(now,previousUntil)+ACCESS_DAYS*86400000);const customerName=payload.customer_name?String(payload.customer_name).trim():null;
    await pool.query("INSERT INTO club_users (email,name,tariff,access_until,purchase_at,status) VALUES ($1,$2,$3,$4,now(),'active') ON CONFLICT (email) DO UPDATE SET name=COALESCE(EXCLUDED.name,club_users.name),tariff=EXCLUDED.tariff,access_until=EXCLUDED.access_until,purchase_at=now(),status='active',updated_at=now()",[email,customerName,inferTariff(payload),accessUntil]);
    return res.status(200).send('ok');
  }catch(error){next(error);}
});
app.use(express.static(process.cwd(),{index:'index.html'}));
app.use((error,req,res,next)=>{console.error(error);if(res.headersSent)return next(error);res.status(500).json({message:'Внутренняя ошибка сервера'});});
await initDatabase();
app.listen(PORT,'0.0.0.0',()=>console.log('Club server listening on '+PORT));

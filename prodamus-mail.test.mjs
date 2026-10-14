import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import pg from 'pg';
import {premiumPasswordForOrder} from './checkout.mjs';
import {prodamusDeliveryMode,PLATFORM_ACCESS_NOTICE} from './prodamus-mail.mjs';
import {drainAccessMail} from './cloudpayments-store.mjs';
import {sendCredentialsEmail,sendBasicAccessEmail} from './email.mjs';
import {pollMailStatuses} from './mail-monitor.mjs';

const dsn=process.env.CLOUDPAYMENTS_TEST_DB_URL;
const key='synthetic-only-prodamus-checkout-key-32-characters';
const secret='synthetic-only-prodamus-signature-secret';
const origin='https://sales.example.test';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?
  Object.fromEntries(Object.keys(value).sort().map(k=>[k,sorted(value[k])])):value==null?'':String(value);
const sign=body=>crypto.createHmac('sha256',secret).update(JSON.stringify(sorted(body)).replace(/\//g,'\\/')).digest('hex');
const post=(base,path,body,headers={})=>fetch(base+path,{method:'POST',
  headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});

test('Prodamus access: safe default, invalid mode and missing mail config fail closed',()=>{
  assert.equal(prodamusDeliveryMode({}),'prodamus');
  assert.throws(()=>prodamusDeliveryMode({PRODAMUS_ACCESS_DELIVERY:'unexpected'}));
  assert.throws(()=>prodamusDeliveryMode({PRODAMUS_ACCESS_DELIVERY:'platform'}));
  assert.equal(prodamusDeliveryMode({PRODAMUS_ACCESS_DELIVERY:'platform',
    PRODAMUS_ACCESS_WORKER_ENABLED:'true',AUTH_EMAIL_PROVIDER:'notisend',NOTISEND_API_KEY:'synthetic',AUTH_FROM_EMAIL:'care@example.test'}),'platform');
  assert.throws(()=>prodamusDeliveryMode({PRODAMUS_ACCESS_DELIVERY:'platform',
    PRODAMUS_ACCESS_WORKER_ENABLED:'false',AUTH_EMAIL_PROVIDER:'notisend',NOTISEND_API_KEY:'synthetic',AUTH_FROM_EMAIL:'care@example.test'}));
});

test('Prodamus access: isolated checkout → signed payment → durable mail → delivery → admin',
  {skip:!dsn},async t=>{
  const source=new URL(dsn);
  assert.equal(source.hostname,'127.0.0.1');assert.equal(source.pathname,'/club_cloudpayments_test');
  const schema='prodamus_mail_'+crypto.randomBytes(8).toString('hex');
  const admin=new pg.Pool({connectionString:dsn});
  await admin.query('CREATE SCHEMA '+schema);
  source.searchParams.set('options','-c search_path='+schema);
  const database=source.href;
  const pool=new pg.Pool({connectionString:database});
  const children=[];
  t.after(async()=>{
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){const ended=new Promise(r=>child.once('exit',r));child.kill();await ended;}
    await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();
  });
  async function boot(mode='prodamus',worker='true'){
    const reservation=net.createServer().listen(0,'127.0.0.1');
    await new Promise(r=>reservation.once('listening',r));
    const port=reservation.address().port;await new Promise(r=>reservation.close(r));
    const child=spawn(process.execPath,['--import','./prodamus-mail-test-guard.mjs','server.mjs'],{
      cwd:new URL('.',import.meta.url),env:{PATH:process.env.PATH,PORT:String(port),PGSSL:'false',
        DATABASE_URL:database,PUBLIC_URL:'https://club.example.test',NODE_ENV:'test',
        AUTH_CREDENTIAL_KEY:key,PRODAMUS_SECRET_KEY:secret,SALES_ORIGINS:origin,
        PRODAMUS_ACCESS_DELIVERY:mode,PRODAMUS_ACCESS_WORKER_ENABLED:worker,AUTH_EMAIL_PROVIDER:'notisend',
        AUTH_FROM_EMAIL:'care@example.test',NOTISEND_API_KEY:'synthetic-mail-key',
        CLUB_ADMIN_ENABLED:'true',CLOUDPAYMENTS_ENABLED:'false',CHECKOUT_PROVIDER:'prodamus',
        BASIC_CHECKOUT_ENABLED:'true',BASIC_ACCESS_URL:'https://t.me/+synthetic-test'}});
    children.push(child);
    await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>reject(new Error('Synthetic app startup timeout: '+output)),12000);
      child.stderr.on('data',d=>{output+=d;});
      child.stdout.on('data',d=>{if(String(d).includes('Club server listening')){clearTimeout(timer);resolve();}});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('Synthetic app stopped: '+output));});
    });
    return {base:'http://127.0.0.1:'+port,async stop(){
      if(child.exitCode===null&&child.signalCode===null){const ended=new Promise(r=>child.once('exit',r));child.kill();await ended;}
    }};
  }
  let app=await boot();
  async function checkout(email,tariff='premium'){
    const docs=await (await fetch(app.base+'/api/legal/checkout-documents')).json();
    const response=await post(app.base,'/api/checkout/session',{email,tariff,buyerName:'Тестовая Участница',
      consents:{personalData:true,marketing:false,offer:true,
        documents:Object.fromEntries(Object.entries(docs.documents).map(([k,v])=>[k,v.id]))}},{Origin:origin});
    assert.equal(response.status,200,await response.clone().text());return response.json();
  }
  const payload=(order,id)=>({order_id:id,order_num:order.order_id,sum:String(order.products[0].price),
    customer_email:order.customer_email,currency:'rub',products:order.products,payment_status:'success'});
  const notify=(order,id,changes={},signed=true)=>{
    const body={...payload(order,id),...changes};
    return post(app.base,'/api/webhooks/prodamus',body,{Sign:signed?sign(body):'invalid'});
  };
  const old=await checkout('old@example.test');
  await t.test('default keeps the existing Prodamus access letter and creates no mail tables',async()=>{
    assert.match(old.paid_content,/Пароль:/);
    assert.equal((await pool.query("SELECT to_regclass('club_cp_orders') AS name")).rows[0].name,null);
  });
  await app.stop();app=await boot('platform');
  const premium=await checkout('owner@example.test');
  const duplicate=await checkout('owner@example.test');
  const basic=await checkout('basic@example.test','basic');
  const uncertain=await checkout('uncertain@example.test');
  const stale=await checkout('stale@example.test');
  const changed=await checkout('changed@example.test');
  await t.test('new orders have no credentials in paid_content; old direct checkout stays unchanged',async()=>{
    assert.equal(premium.paid_content,PLATFORM_ACCESS_NOTICE);
    assert.equal(basic.paid_content,PLATFORM_ACCESS_NOTICE);
    for(const [order,platform] of [[old,false],[premium,true]]){
      const direct=await post(app.base,'/api/checkout/direct',{orderId:order.order_id,email:order.customer_email},{Origin:origin});
      assert.equal(direct.status,200);
      const content=(await direct.json()).fields.find(f=>f.name==='paid_content').value;
      assert.equal(content.includes('Пароль:'),!platform);
    }
  });
  await t.test('bad signature, altered amount/email, and unsuccessful status issue nothing',async()=>{
    assert.equal((await notify(premium,'101',{},false)).status,400);
    assert.equal((await notify(premium,'101',{sum:'1.00'})).status,422);
    assert.equal((await notify(premium,'101',{customer_email:'intruder@example.test'})).status,422);
    assert.equal((await notify(premium,'101',{payment_status:'fail'})).status,200);
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM club_cp_access_mail')).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM club_users')).rows[0].n,0);
  });
  await app.stop();app=await boot('prodamus');
  await t.test('rollback of the switch preserves previously marked orders, but new orders use Prodamus',async()=>{
    const reverted=await checkout('reverted@example.test');assert.match(reverted.paid_content,/Пароль:/);
    const direct=await post(app.base,'/api/checkout/direct',{orderId:premium.order_id,email:premium.customer_email},{Origin:origin});
    assert.equal((await direct.json()).fields.find(f=>f.name==='paid_content').value,PLATFORM_ACCESS_NOTICE);
  });
  await t.test('concurrent genuine duplicate payments grant one account and queue one email',async()=>{
    const replies=await Promise.all(Array.from({length:6},()=>notify(premium,'101')));
    for(const r of replies)assert.equal(r.status,200,await r.text());
    assert.equal((await notify(premium,'102')).status,200);
    const count=(await pool.query(`SELECT (SELECT count(*) FROM club_users)::integer AS users,
      (SELECT count(*) FROM club_cp_access_mail)::integer AS mails,
      (SELECT count(*) FROM club_cp_payments)::integer AS transactions`)).rows[0];
    assert.deepEqual(count,{users:1,mails:1,transactions:2});
    const login=await post(app.base,'/api/auth/login',{email:premium.customer_email,password:premiumPasswordForOrder(premium.order_id,key)});
    assert.equal(login.status,200);assert.equal((await login.json()).email,premium.customer_email);
  });
  await t.test('an explicitly disabled worker leaves paid jobs pending even when the shared ledger exists',async()=>{
    await app.stop();app=await boot('prodamus','false');
    const mail=(await pool.query('SELECT state FROM club_cp_access_mail WHERE order_id=$1',[premium.order_id])).rows[0];
    assert.equal(mail.state,'pending');
  });
  await t.test('a second paid checkout for the same buyer is review-only, without rotating passwords',async()=>{
    assert.equal((await notify(duplicate,'103')).status,200);
    const order=(await pool.query('SELECT status FROM club_cp_orders WHERE order_id=$1',[duplicate.order_id])).rows[0];
    assert.equal(order.status,'review');
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM club_cp_access_mail')).rows[0].n,1);
  });

  Object.assign(process.env,{AUTH_EMAIL_PROVIDER:'notisend',AUTH_FROM_EMAIL:'care@example.test',NOTISEND_API_KEY:'synthetic-mail-key'});
  const originalFetch=globalThis.fetch;
  let transportMode='rate-limit',dispatches=0;
  globalThis.fetch=async(url,options)=>{
    if(String(url).startsWith('https://api.notisend.ru/')){
      dispatches++;
      if(transportMode==='rate-limit')return new Response('{}',{status:429,headers:{'Retry-After':'3600'}});
      if(transportMode==='uncertain')throw new Error('Synthetic connection interrupted after dispatch');
      const body=JSON.parse(options.body);
      assert.equal(body.from_email,'care@example.test');
      assert.ok(body.text.includes('Пароль:')||body.text.includes('Telegram'));
      return new Response(JSON.stringify({id:'synthetic-mail-'+dispatches,status:'queued'}),{status:201});
    }
    return originalFetch(url,options);
  };
  t.after(()=>{globalThis.fetch=originalFetch;});
  const send=async(order,mail)=>{
    if(order.tariff==='basic')return sendBasicAccessEmail(order.buyer_email,'https://club.example.test/access/basic/'+order.order_id);
    const [iv,tag,data]=mail.password_ciphertext.split('.').map(v=>Buffer.from(v,'base64url'));
    const decipher=crypto.createDecipheriv('aes-256-gcm',crypto.createHash('sha256').update(key).digest(),iv);
    decipher.setAuthTag(tag);
    const password=Buffer.concat([decipher.update(data),decipher.final()]).toString();
    assert.equal(password,premiumPasswordForOrder(order.order_id,key));
    return sendCredentialsEmail(order.buyer_email,password,'https://club.example.test');
  };
  const drain=()=>drainAccessMail(pool,send,10,['prodamus']);
  await t.test('429 delays the retry, but confirmed payment and working login remain intact',async()=>{
    await drain();
    const mail=(await pool.query('SELECT state,last_error_code,next_attempt_at>now()+interval \'59 minutes\' AS delayed FROM club_cp_access_mail')).rows[0];
    assert.deepEqual(mail,{state:'pending',last_error_code:'provider_rate_limit',delayed:true});
    assert.equal((await pool.query('SELECT status FROM club_cp_orders WHERE order_id=$1',[premium.order_id])).rows[0].status,'paid');
    await drain();assert.equal(dispatches,1);
  });
  await t.test('parallel workers dispatch once and store only receipt metadata; delivery is tracked separately',async()=>{
    await pool.query("UPDATE club_cp_access_mail SET next_attempt_at=now()-interval '1 second'");
    transportMode='success';
    await Promise.all([drain(),drain()]);
    assert.equal(dispatches,2);
    let mail=(await pool.query('SELECT state,delivery_status,password_ciphertext FROM club_cp_access_mail')).rows[0];
    assert.deepEqual(mail,{state:'accepted',delivery_status:'queued',password_ciphertext:null});
    await drain();assert.equal(dispatches,2);
    await pool.query('UPDATE club_cp_access_mail SET next_status_check_at=now()');
    assert.equal((await pollMailStatuses(pool,{reader:async()=> 'delivered',delay:0})).refreshed,1);
    mail=(await pool.query('SELECT delivery_status FROM club_cp_access_mail')).rows[0];assert.equal(mail.delivery_status,'delivered');
    const stored=JSON.stringify((await pool.query('SELECT * FROM club_cp_mail_history')).rows);
    assert.equal(stored.includes(premiumPasswordForOrder(premium.order_id,key)),false);
  });
  await t.test('the basic tariff sends its own paid-only Telegram link, without a cabinet account',async()=>{
    assert.equal((await notify(basic,'104')).status,200);
    const access=await fetch(app.base+'/access/basic/'+basic.order_id,{redirect:'manual'});
    assert.equal(access.status,302);
    assert.equal(access.headers.get('location'),'https://t.me/+synthetic-test');
    await drain();
    assert.equal((await pool.query('SELECT count(*)::integer AS n FROM club_users WHERE login_email=$1',[basic.customer_email])).rows[0].n,0);
  });
  await t.test('network uncertainty and expired leases are blocked, not redispatched automatically',async()=>{
    assert.equal((await notify(uncertain,'105')).status,200);
    transportMode='uncertain';await drain();
    const count=dispatches;await drain();assert.equal(dispatches,count);
    assert.equal((await notify(stale,'106')).status,200);
    await pool.query("UPDATE club_cp_access_mail SET state='sending',claim_token='synthetic-expired',claimed_at=now()-interval '11 minutes' WHERE order_id=$1",[stale.order_id]);
    await drain();assert.equal(dispatches,count);
    const blocked=(await pool.query("SELECT state,last_error_code FROM club_cp_access_mail WHERE order_id IN($1,$2)",[uncertain.order_id,stale.order_id])).rows;
    assert.equal(blocked.length,2);for(const row of blocked)assert.deepEqual(row,{state:'blocked',last_error_code:'send_uncertain'});
  });
  await t.test('admin sees Prodamus payment/delivery/history, with authentication, CSRF and guarded resend',async()=>{
    const guest=await fetch(app.base+'/api/admin/orders');assert.equal(guest.status,401);
    const login=await post(app.base,'/api/auth/login',{email:premium.customer_email,password:premiumPasswordForOrder(premium.order_id,key)});
    const cookie=login.headers.get('set-cookie').split(';')[0];
    assert.equal((await fetch(app.base+'/api/admin/orders',{headers:{Cookie:cookie}})).status,403);
    await pool.query('INSERT INTO club_admin_accounts(user_key) VALUES($1)',['order:'+premium.order_id]);
    const list=await (await fetch(app.base+'/api/admin/orders?filter=all',{headers:{Cookie:cookie}})).json();
    assert.equal(list.enabled,true);assert.ok(list.orders.some(o=>o.payment_provider==='prodamus'&&o.delivery_status==='delivered'));
    const detail=await (await fetch(app.base+'/api/admin/orders/'+uncertain.order_id,{headers:{Cookie:cookie}})).json();
    assert.equal(detail.order.last_error_code,'send_uncertain');
    const body={reason:'delivery_failed',expectedAttempts:detail.order.attempts,expectedMessageId:null};
    assert.equal((await post(app.base,'/api/admin/orders/'+uncertain.order_id+'/resend',body,{Cookie:cookie,Origin:'https://club.example.test'})).status,403);
    const headers={Cookie:cookie,Origin:'https://club.example.test','X-CSRF-Token':list.csrfToken};
    assert.equal((await post(app.base,'/api/admin/orders/'+uncertain.order_id+'/resend',body,headers)).status,409);
    assert.equal((await post(app.base,'/api/admin/orders/'+uncertain.order_id+'/resend',{...body,reason:'customer_request'},headers)).status,200);
  });
  await t.test('a changed password prevents the production worker from sending stale credentials',async()=>{
    assert.equal((await notify(changed,'107')).status,200);
    await pool.query("UPDATE club_users SET password_hash='scrypt$changed$invalid' WHERE email=$1",['order:'+changed.order_id]);
    await app.stop();app=await boot('prodamus');
    const mail=(await pool.query('SELECT state,last_error_code FROM club_cp_access_mail WHERE order_id=$1',[changed.order_id])).rows[0];
    assert.deepEqual(mail,{state:'blocked',last_error_code:'credentials_review'});
  });
});

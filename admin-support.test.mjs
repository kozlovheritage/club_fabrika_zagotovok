import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {promisify} from 'node:util';
import {spawn} from 'node:child_process';
import net from 'node:net';
import pg from 'pg';
import {ADMIN_SCHEMA,createAdminStore,provisionOwner} from './admin-store.mjs';
import {MAIL_MONITOR_SCHEMA,readNotisendStatus,pollMailStatuses,notifyMailAttention} from './mail-monitor.mjs';
import {CLOUD_SCHEMA,drainAccessMail} from './cloudpayments-store.mjs';
import {premiumPasswordForOrder} from './checkout.mjs';

const dsn=process.env.CLOUDPAYMENTS_TEST_DB_URL;
const key='synthetic-admin-signing-key-at-least-32-characters';
const schema='admin_test_'+crypto.randomBytes(6).toString('hex');
let pool,root,child,base;
const hash=async password=>{
  const salt=crypto.randomBytes(16).toString('hex');
  const derived=await promisify(crypto.scrypt)(password,salt,64);
  return 'scrypt$'+salt+'$'+derived.toString('hex');
};
async function boot(){
  const reservation=net.createServer().listen(0,'127.0.0.1');
  await new Promise(r=>reservation.once('listening',r));
  const port=reservation.address().port;
  await new Promise(r=>reservation.close(r));
  child=spawn(process.execPath,['server.mjs'],{cwd:new URL('.',import.meta.url),
    env:{PATH:process.env.PATH,NODE_ENV:'test',PORT:String(port),PGSSL:'false',
      PGOPTIONS:'-c search_path='+schema,DATABASE_URL:dsn,PUBLIC_URL:'https://club.example.test',
      AUTH_CREDENTIAL_KEY:key,CLOUDPAYMENTS_ENABLED:'true',CLOUDPAYMENTS_MODE:'live',
      CLOUDPAYMENTS_PUBLIC_ID:'synthetic-only',CLOUDPAYMENTS_API_SECRET:'synthetic-only-secret',
      CLOUDPAYMENTS_TERMINAL_MODE_CONFIRMED:'false',CLOUDPAYMENTS_RECEIPT_APPROVED:'false',
      CLUB_ADMIN_ENABLED:'true',CHECKOUT_PROVIDER:'prodamus'}});
  await new Promise((resolve,reject)=>{
    let errors='';
    const timeout=setTimeout(()=>reject(new Error('Synthetic admin startup timed out')),12000);
    child.stderr.on('data',b=>{errors+=b;});
    child.stdout.on('data',b=>{if(String(b).includes('Club server listening')){clearTimeout(timeout);resolve();}});
    child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Synthetic startup failed: '+errors));});
  });
  base='http://127.0.0.1:'+port;
}
before(async()=>{
  if(!dsn)return;
  const url=new URL(dsn);
  assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/club_cloudpayments_test');
  root=new pg.Pool({connectionString:dsn});
  await root.query('CREATE SCHEMA '+schema);
  pool=new pg.Pool({connectionString:dsn,options:'-c search_path='+schema});
  await boot(); // Actual server applies all additive migrations to this isolated schema.
});
after(async()=>{
  if(child&&child.exitCode===null){
    const exit=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exit;
  }
  if(pool)await pool.end();
  if(root){await root.query('DROP SCHEMA '+schema+' CASCADE');await root.end();}
});
beforeEach(async()=>{
  if(dsn)await pool.query(`TRUNCATE club_users,club_cp_orders,club_admin_audit,club_webhook_events CASCADE`);
  if(dsn)await pool.query('UPDATE club_mail_alert_state SET active=false,last_sent_at=NULL,claim_token=NULL,claimed_at=NULL');
});
const scenario=(name,fn)=>test(name,{skip:!dsn},fn);
async function member(email='owner@example.test',name='Synthetic Preview'){
  await pool.query(`INSERT INTO club_users(email,name,password_hash) VALUES($1,$2,$3)`,
    [email,name,await hash('synthetic-test-password')]);
  return email;
}
async function owner(){
  const userKey=await member();
  await provisionOwner(pool,{email:userKey,expectedName:'Synthetic Preview',displayName:'Тестовый Администратор'});
  return userKey;
}
async function login(email='owner@example.test',password='synthetic-test-password'){
  const response=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email,password})});
  assert.equal(response.status,200);
  return response.headers.get('set-cookie').split(';')[0];
}
async function request(path,{cookie,method='GET',body,token,origin='https://club.example.test'}={}){
  return fetch(base+path,{method,headers:{
    ...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{}),
    ...(token?{'X-CSRF-Token':token}:{}),...(method==='POST'?{Origin:origin}:{})
  },...(body?{body:JSON.stringify(body)}:{})});
}
async function order({id='synthetic-order',tariff='basic',state='accepted',status='soft_bounced',testMode=false}={}){
  if(tariff==='premium')id='fz4-p-'+id;
  await pool.query(`INSERT INTO club_cp_orders(order_id,buyer_email,buyer_name,tariff,amount_cents,test_mode,status,last_payment_status,paid_at)
    VALUES($1,'buyer@example.test','Тестовый Участник',$2,599000,$3,'paid','paid',now()-interval '1 day')`,
  [id,tariff,testMode]);
  await pool.query("INSERT INTO club_cp_payments VALUES($1,$2,'fulfilled',now())",['txn-'+id,id]);
  let userKey=null;
  if(tariff==='premium'){
    userKey='order:'+id;
    const password=premiumPasswordForOrder(id,key);
    await pool.query(`INSERT INTO club_users(email,login_email,name,password_hash,password_tag)
      VALUES($1,'buyer@example.test','Тестовый Участник',$2,$3)`,
    [userKey,await hash(password),crypto.createHash('sha256').update('club-order-password:'+password).digest('hex')]);
  }
  await pool.query(`INSERT INTO club_cp_access_mail(order_id,user_key,state,attempts,provider,provider_message_id,
    delivery_status,last_sent_at,next_status_check_at)
    VALUES($1,$2,$3,1,'notisend',$4,$5,now()-interval '1 hour',now()-interval '1 minute')`,
  [id,userKey,state,'message-'+id,status]);
  return id;
}

scenario('manual access confirmation: authenticated, audited, persistent, preserves source status and prevents retries',async()=>{
  const actor=await owner();const cookie=await login();
  const id=await order({id:'manual-confirm',tariff:'premium',state:'pending',status:'unknown'});
  await pool.query("UPDATE club_cp_access_mail SET provider='prodamus',provider_message_id=NULL,attempts=0 WHERE order_id=$1",[id]);
  const list=await(await request('/api/admin/orders',{cookie})).json();
  const body={confirmed:true,expectedAttempts:0,expectedMessageId:null};
  const path='/api/admin/orders/'+id+'/confirm-access';
  assert.equal((await request(path,{method:'POST',body})).status,401);
  assert.equal((await request(path,{method:'POST',body,cookie})).status,403);
  await member('ordinary@example.test');const ordinary=await login('ordinary@example.test');
  assert.equal((await request(path,{method:'POST',body,cookie:ordinary,token:list.csrfToken})).status,403);
  assert.equal((await request(path,{method:'POST',body:{...body,confirmed:false},cookie,token:list.csrfToken})).status,400);
  assert.equal((await request(path,{method:'POST',body:{...body,expectedAttempts:3},cookie,token:list.csrfToken})).status,409);
  assert.equal((await request(path,{method:'POST',body,cookie,token:list.csrfToken,origin:'https://other.example.test'})).status,403);
  for(let i=0;i<2;i++)assert.equal((await request(path,{method:'POST',body,cookie,token:list.csrfToken})).status,200);
  const stored=(await pool.query(`SELECT access_confirmed_at,access_confirmed_by,status,last_payment_status FROM club_cp_orders WHERE order_id=$1`,[id])).rows[0];
  assert.ok(stored.access_confirmed_at);assert.equal(stored.access_confirmed_by,actor);assert.equal(stored.status,'paid');assert.equal(stored.last_payment_status,'paid');
  const mail=(await pool.query('SELECT state,provider,delivery_status,attempts FROM club_cp_access_mail WHERE order_id=$1',[id])).rows[0];
  assert.deepEqual(mail,{state:'pending',provider:'prodamus',delivery_status:'unknown',attempts:0});
  const updated=await(await request('/api/admin/orders',{cookie})).json();
  assert.equal(updated.total,0);assert.equal(updated.summary.delivered,1);assert.equal(updated.summary.attention,0);
  const accepted=await(await request('/api/admin/orders?filter=accepted',{cookie})).json();
  assert.equal(accepted.total,1);assert.equal(accepted.orders[0].order_id,id);assert.ok(accepted.orders[0].access_confirmed_at);
  assert.equal((await pool.query("SELECT count(*)::int n FROM club_admin_audit WHERE order_id=$1 AND action='access:confirmed'",[id])).rows[0].n,1);
  let sends=0;await drainAccessMail(pool,async()=>{sends++;});
  assert.equal(sends,0);
  // A later reversal must surface again even after a manual access confirmation.
  await pool.query(`INSERT INTO club_cp_payment_events(event_id,order_id,payment_provider,event_type,provider_status)
    VALUES('manual-late-refund',$1,'cloudpayments','refund','refunded')`,[id]);
  assert.equal((await(await request('/api/admin/orders',{cookie})).json()).total,1);
  assert.equal((await(await request('/api/admin/orders?filter=accepted',{cookie})).json()).total,0);
  assert.equal((await request(path,{method:'POST',body,cookie,token:list.csrfToken})).status,409);
});

scenario('manual confirmation refuses unpaid, failed, test, canceled, unfulfilled and inactive-account orders',async()=>{
  await owner();const cookie=await login();const token=(await(await request('/api/admin/orders',{cookie})).json()).csrfToken;
  for(const variant of ['unpaid','failed','test','canceled','unfulfilled','inactive']){
    const id=await order({id:'refuse-'+variant,tariff:'premium',testMode:variant==='test'});
    if(variant==='unpaid')await pool.query("UPDATE club_cp_orders SET status='pending',last_payment_status='pending' WHERE order_id=$1",[id]);
    if(variant==='failed'||variant==='canceled')await pool.query('UPDATE club_cp_orders SET last_payment_status=$2 WHERE order_id=$1',[id,variant]);
    if(variant==='unfulfilled')await pool.query("UPDATE club_cp_payments SET outcome='review' WHERE order_id=$1",[id]);
    if(variant==='inactive')await pool.query("UPDATE club_users SET status='disabled' WHERE email=$1",['order:'+id]);
    const r=await request('/api/admin/orders/'+id+'/confirm-access',{cookie,token,method:'POST',
      body:{confirmed:true,expectedAttempts:1,expectedMessageId:'message-'+id}});
    assert.equal(r.status,409);
    assert.equal((await pool.query('SELECT access_confirmed_at FROM club_cp_orders WHERE order_id=$1',[id])).rows[0].access_confirmed_at,null);
  }
});

scenario('browser: confirmed access leaves attention, appears in accepted and survives reload on desktop/mobile',async()=>{
  const {chromium}=await import('playwright');const {mkdir}=await import('node:fs/promises');
  await owner();const id=await order({id:'manual-browser',tariff:'premium',state:'blocked',status:'unknown'});
  const browser=await chromium.launch({executablePath:process.env.CLUB_TEST_CHROMIUM,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url());if(url.origin!=='https://club.example.test')return route.abort();
      const response=await route.fetch({url:base+url.pathname+url.search});await route.fulfill({response});
    });
    await page.goto('https://club.example.test/admin');
    await page.evaluate(()=>fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'owner@example.test',password:'synthetic-test-password'})}));
    await page.goto('https://club.example.test/admin');
    await page.locator('[data-filter="unverified"]').click();
    await page.locator('.order-row').first().click();
    await page.locator('#confirmAccessButton').click();
    await page.locator('#cancelConfirmAccess').click();
    assert.equal((await pool.query('SELECT access_confirmed_at FROM club_cp_orders WHERE order_id=$1',[id])).rows[0].access_confirmed_at,null);
    await page.locator('#confirmAccessButton').click();
    await page.locator('#accessConfirmedCheck').check();
    await page.locator('#submitConfirmAccess').click();
    await page.waitForFunction(()=>document.querySelector('#confirmAccessButton').disabled&&document.querySelector('#summaryAttention').textContent==='0');
    assert.equal(await page.locator('#summaryDelivered').textContent(),'1');
    assert.match(await page.locator('#detailContent').textContent(),/Подтверждено вручную/);
    await page.locator('#closeDialog').click();
    assert.equal(await page.locator('.order-row').count(),0);
    await page.locator('[data-filter="accepted"]').click();
    await page.waitForFunction(()=>document.querySelectorAll('.order-row').length===1);
    assert.match(await page.locator('.order-row').textContent(),/Письмо принято · вручную/);
    if(process.env.CLUB_TEST_SCREENSHOT_DIR){await mkdir(process.env.CLUB_TEST_SCREENSHOT_DIR,{recursive:true});
      await page.screenshot({path:process.env.CLUB_TEST_SCREENSHOT_DIR+'/manual-confirm-desktop.jpg',type:'jpeg',quality:80});}
    await page.reload();
    await page.waitForFunction(()=>document.querySelector('#summaryDelivered').textContent==='1');
    await page.locator('[data-filter="accepted"]').click();
    await page.locator('.order-row').first().click();
    await page.waitForFunction(()=>document.querySelector('#confirmAccessButton').disabled&&
      document.querySelector('#detailContent').textContent.includes('Подтверждено вручную'));
    assert.equal(await page.locator('#confirmAccessButton').isDisabled(),true);
    assert.match(await page.locator('#detailContent').textContent(),/Доставка неизвестна/);
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    if(process.env.CLUB_TEST_SCREENSHOT_DIR)await page.screenshot({path:process.env.CLUB_TEST_SCREENSHOT_DIR+'/manual-confirm-mobile.jpg',type:'jpeg',quality:80});
    assert.equal((await pool.query("SELECT count(*)::int n FROM club_admin_audit WHERE order_id=$1 AND action='access:confirmed'",[id])).rows[0].n,1);
  }finally{await browser.close();}
});

scenario('actual app: guest/member/same-email duplicate cannot access admin HTML, assets or APIs',async()=>{
  const userKey=await owner();
  for(const path of ['/admin','/admin/admin.js','/api/admin/orders']){
    assert.equal((await request(path)).status,401);
  }
  await member('member@example.test');
  const regular=await login('member@example.test');
  for(const path of ['/admin','/admin/admin.css','/api/admin/orders']){
    assert.equal((await request(path,{cookie:regular})).status,403);
  }
  await pool.query(`INSERT INTO club_users(email,login_email,name,password_hash,password_tag)
    VALUES('order:duplicate','owner@example.test','Another purchase',$1,$2)`,
  [await hash('different-synthetic-password'),crypto.createHash('sha256').update('club-order-password:different-synthetic-password').digest('hex')]);
  const duplicate=await login('owner@example.test','different-synthetic-password');
  assert.equal((await request('/api/admin/orders',{cookie:duplicate})).status,403);
  const adminCookie=await login();
  const page=await request('/admin',{cookie:adminCookie});
  assert.equal(page.status,200);assert.match(page.headers.get('cache-control'),/no-store/);
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.match(await page.text(),/Оплата и доступ/);
  assert.match(await (await request('/club',{cookie:adminCookie})).text(),/href="\/admin"/);
  assert.doesNotMatch(await (await request('/club',{cookie:regular})).text(),/href="\/admin"/);
  const profile=await (await request('/api/auth/me',{cookie:adminCookie})).json();
  assert.equal(profile.name,'Тестовый Администратор');assert.equal(profile.email,userKey);
  assert.equal('user_key' in profile,false);
  await pool.query('UPDATE club_admin_accounts SET enabled=false');
  assert.equal((await request('/api/admin/orders',{cookie:adminCookie})).status,403);
});
scenario('provision changes only exact name/role, is idempotent; ambiguity and wrong previous name fail closed',async()=>{
  const userKey=await member();
  const original=(await pool.query('SELECT * FROM club_users WHERE email=$1',[userKey])).rows[0];
  const args={email:userKey,expectedName:'Synthetic Preview',displayName:'Тестовый Администратор'};
  await provisionOwner(pool,args);await provisionOwner(pool,args);
  const changed=(await pool.query('SELECT * FROM club_users WHERE email=$1',[userKey])).rows[0];
  for(const field of ['email','login_email','password_hash','tariff','status','access_until'])
    assert.deepEqual(changed[field],original[field]);
  assert.equal(changed.name,args.displayName);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM club_admin_audit')).rows[0].n,1);
  await member('wrong@example.test','Not expected');
  await assert.rejects(provisionOwner(pool,{...args,email:'wrong@example.test'}));
  await pool.query("INSERT INTO club_users(email,login_email,name) VALUES('order:ambiguous',$1,'Other')",[userKey]);
  await assert.rejects(provisionOwner(pool,args),/ambiguous/);
});
scenario('orders expose safe fields, genuine attention, live-only search and explicit queued != delivered',async()=>{
  await owner();const cookie=await login();
  await order({id:'bounced'});await order({id:'queued',status:'queued'});
  await pool.query("UPDATE club_cp_access_mail SET last_sent_at=now() WHERE order_id='queued'");
  await order({id:'delivered',status:'delivered'});
  await order({id:'test-only',testMode:true});
  const all=await (await request('/api/admin/orders?filter=all',{cookie})).json();
   assert.equal(all.total,3);assert.deepEqual(all.summary,{attention:1,delivered:1,inProgress:1,unverified:0});
  assert.ok(all.csrfToken);assert.equal(all.alertsConfigured,false);
  assert.doesNotMatch(JSON.stringify(all),/password|ciphertext|payment_url|claim_token|transaction_id|user_key/);
  const attention=await (await request('/api/admin/orders',{cookie})).json();
  assert.deepEqual(attention.orders.map(x=>x.order_id),['bounced']);
  const match=await (await request('/api/admin/orders?filter=all&q=delivered',{cookie})).json();
  assert.equal(match.total,1);
  const literal=await (await request('/api/admin/orders?filter=all&q=%25',{cookie})).json();
  assert.equal(literal.total,0);
  assert.equal((await request('/api/admin/orders/test-only',{cookie})).status,404);
});
scenario('mutation denies missing CSRF, wrong Origin, cross-session tokens and stale/double resend',async()=>{
  await owner();const cookie=await login();
  const id=await order();
  const listing=await (await request('/api/admin/orders',{cookie})).json();
  const body={reason:'delivery_failed',expectedAttempts:1,expectedMessageId:'message-'+id};
  const path='/api/admin/orders/'+id+'/resend';
  assert.equal((await request(path,{cookie,method:'POST',body})).status,403);
  assert.equal((await request(path,{cookie,method:'POST',body,token:listing.csrfToken,origin:'https://sales.example.test'})).status,403);
  const other=await login();
  assert.equal((await request(path,{cookie:other,method:'POST',body,token:listing.csrfToken})).status,403);
  const results=await Promise.all([1,2].map(()=>request(path,{cookie,method:'POST',body,token:listing.csrfToken})));
  assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM club_admin_audit WHERE order_id=$1',[id])).rows[0].n,1);
  const before=(await pool.query('SELECT count(*)::integer AS n FROM club_cp_payments')).rows[0].n;
  assert.equal(before,1);
});
scenario('premium resend preserves verified password/hash and account; rotated credentials never sent',async()=>{
  const admin=await owner();
  const id=await order({tariff:'premium'});
  const before=(await pool.query('SELECT * FROM club_users WHERE email=$1',['order:'+id])).rows[0];
  const cookie=await login();
  const token=(await (await request('/api/admin/orders',{cookie})).json()).csrfToken;
  const body={reason:'delivery_failed',expectedAttempts:1,expectedMessageId:'message-'+id};
  const response=await request('/api/admin/orders/'+id+'/resend',{cookie,method:'POST',body,token});
  assert.equal(response.status,200);
  const afterRow=(await pool.query('SELECT * FROM club_users WHERE email=$1',['order:'+id])).rows[0];
  assert.deepEqual(afterRow,before);
  assert.ok((await pool.query('SELECT password_ciphertext FROM club_cp_access_mail')).rows[0].password_ciphertext);
  await drainAccessMail(pool,async()=>({provider:'notisend',messageId:'resend-id',status:'queued',recipient:'buyer@example.test'}));
  assert.equal((await pool.query('SELECT password_ciphertext FROM club_cp_access_mail')).rows[0].password_ciphertext,null);
  await pool.query("UPDATE club_cp_access_mail SET last_sent_at=now()-interval '1 hour'");
  await pool.query("UPDATE club_users SET password_hash=$2 WHERE email=$1",['order:'+id,await hash('rotated-synthetic-password')]);
  const response2=await request('/api/admin/orders/'+id+'/resend',{cookie,method:'POST',token,
    body:{...body,expectedAttempts:2,expectedMessageId:'resend-id'}});
  assert.equal(response2.status,409);
  assert.equal((await pool.query('SELECT state FROM club_cp_access_mail')).rows[0].state,'accepted');
  assert.equal(await createAdminStore(pool).isAdmin(admin),true);
});
scenario('refund/cancel → unknown signed notification cannot re-enable resend, even with a stale status projection',async()=>{
  await owner();
  const cookie=await login();
  const token=(await (await request('/api/admin/orders',{cookie})).json()).csrfToken;
  for(const [index,type] of ['refund','cancel'].entries()){
    const id=await order({id:'reversal-'+type,tariff:'premium'});
    const original=String(7001+index);
    await pool.query('UPDATE club_cp_payments SET transaction_id=$2 WHERE order_id=$1',[id,original]);
    const notify=async(kind,payload)=>{
      const raw=JSON.stringify(payload);
      const signature=crypto.createHmac('sha256','synthetic-only-secret').update(raw).digest('base64');
      const response=await fetch(base+'/api/webhooks/cloudpayments/'+kind,{method:'POST',
        headers:{'Content-Type':'application/json','Content-HMAC':signature},body:raw});
      assert.equal(response.status,200);
      assert.deepEqual(await response.json(),{code:0});
    };
    const common={InvoiceId:id,AccountId:id,Amount:'5990.00',TransactionId:original};
    await notify(type,type==='refund'
      ?{...common,TransactionId:String(8001+index),PaymentTransactionId:original,OperationType:'Refund'}:common);
    await notify('pay',{...common,Currency:'RUB',TestMode:0,Status:'UnknownFutureStatus'});
    const projected=await (await request('/api/admin/orders/'+id,{cookie})).json();
    assert.equal(projected.order.last_payment_status,type==='refund'?'refund_reported':'canceled');
    assert.equal(projected.order.payment_requires_review,true);
    assert.equal(projected.paymentHistory.filter(x=>x.event_type==='unknown').length,1);
    const body={reason:'customer_request',expectedAttempts:1,expectedMessageId:'message-'+id};
    assert.equal((await request('/api/admin/orders/'+id+'/resend',{cookie,method:'POST',token,body})).status,409);
    // Prove authorization uses the durable ledger, not only the latest status.
    await pool.query("UPDATE club_cp_orders SET last_payment_status='paid' WHERE order_id=$1",[id]);
    assert.equal((await request('/api/admin/orders/'+id+'/resend',{cookie,method:'POST',token,body})).status,409);
    const refreshed=await (await request('/api/admin/orders/'+id,{cookie})).json();
    assert.equal(refreshed.order.payment_requires_review,true);
    assert.equal(refreshed.order.needs_attention,true);
    const mail=(await pool.query('SELECT state,attempts,password_ciphertext FROM club_cp_access_mail WHERE order_id=$1',[id])).rows[0];
    assert.equal(mail.state,'accepted');assert.equal(mail.attempts,1);assert.equal(mail.password_ciphertext,null);
  }
  assert.equal((await pool.query("SELECT count(*)::int n FROM club_admin_audit WHERE action LIKE 'resend:%'")).rows[0].n,0);
});
scenario('delivered/hard bounce require customer request; no rapid resend, no re-creating payment',async()=>{
  const actor=await owner();
  const store=createAdminStore(pool);
  const id=await order({status:'delivered'});
  const body={reason:'delivery_failed',expectedAttempts:1,expectedMessageId:'message-'+id};
  await assert.rejects(store.resend(id,actor,body),/самого клиента/);
  await store.resend(id,actor,{...body,reason:'customer_request'});
  await pool.query("UPDATE club_cp_access_mail SET state='accepted',last_sent_at=now()");
  await assert.rejects(store.resend(id,actor,{...body,reason:'customer_request'}),/10 минут/);
});
scenario('mail receipt and history commit together; queued becomes final bounce without automatic fresh send',async()=>{
  await order({state:'pending',status:'unknown'});
  await drainAccessMail(pool,async()=>({provider:'notisend',messageId:'provider-123',status:'queued',recipient:'buyer@example.test'}));
  await pool.query("UPDATE club_cp_access_mail SET next_status_check_at=now()-interval '1 second'");
  const result=await pollMailStatuses(pool,{delay:0,reader:async id=>{assert.equal(id,'provider-123');return 'soft_bounced';}});
  assert.equal(result.refreshed,1);
  const mail=(await pool.query('SELECT * FROM club_cp_access_mail')).rows[0];
  assert.equal(mail.delivery_status,'soft_bounced');assert.equal(mail.state,'accepted');
  assert.equal(mail.password_ciphertext,null);
  const history=(await pool.query('SELECT status,provider_message_id FROM club_cp_mail_history')).rows[0];
  assert.deepEqual(history,{status:'soft_bounced',provider_message_id:'provider-123'});
  let sends=0;await drainAccessMail(pool,async()=>{sends++;});assert.equal(sends,0);
  const detail=await createAdminStore(pool).detail('synthetic-order');
  assert.equal(detail.order.needs_attention,true);
});
scenario('leased polling rejects changed ID and failures; no false delivered, bounded claims',async()=>{
  await order({status:'queued'});
  const [a,b]=await Promise.all([pollMailStatuses(pool,{delay:0,reader:async()=>{await new Promise(r=>setTimeout(r,20));return 'delivered';}}),
    pollMailStatuses(pool,{delay:0,reader:async()=>{throw new Error('should not win lease');}})]);
  assert.equal(a.claimed+b.claimed,1);
  const status=(await pool.query('SELECT delivery_status FROM club_cp_access_mail')).rows[0].delivery_status;
  assert.ok(['queued','delivered'].includes(status));
  await pool.query("UPDATE club_cp_access_mail SET delivery_status='queued',next_status_check_at=now()-interval '1 second',status_claimed_at=NULL");
  await pollMailStatuses(pool,{delay:0,reader:async()=>{throw new Error('provider body with private credentials');}});
  const failed=(await pool.query('SELECT delivery_status,last_error_code FROM club_cp_access_mail')).rows[0];
  assert.deepEqual(failed,{delivery_status:'queued',last_error_code:'status_unavailable'});
});
scenario('send backoff is bounded; 8 failures block for review and record only safe reason',async()=>{
  await order({state:'pending'});
  for(let i=0;i<8;i++){
    await pool.query("UPDATE club_cp_access_mail SET next_attempt_at=now()-interval '1 second'");
    await drainAccessMail(pool,async()=>{throw new Error('provider password/body must not leak');});
  }
  const row=(await pool.query('SELECT state,consecutive_failures,last_error_code FROM club_cp_access_mail')).rows[0];
  assert.deepEqual(row,{state:'blocked',consecutive_failures:8,last_error_code:'temporary_send_failure'});
  const history=(await pool.query('SELECT status,error_code FROM club_cp_mail_history')).rows;
  assert.equal(history.length,8);assert.doesNotMatch(JSON.stringify(history),/password|body|leak/);
});
scenario('owner alerts are leased and deduplicated, with recovery and no buyer PII',async()=>{
  await order();let alerts=[];
  const send=async data=>{alerts.push(data);return {messageId:'alert-1',status:'queued'};};
  await Promise.all([notifyMailAttention(pool,send),notifyMailAttention(pool,send)]);
  assert.deepEqual(alerts,[{count:1,recovery:false}]);
  await notifyMailAttention(pool,send);assert.equal(alerts.length,1);
  await pool.query("UPDATE club_cp_access_mail SET delivery_status='delivered'");
  await notifyMailAttention(pool,send);
  assert.deepEqual(alerts[1],{count:0,recovery:true});
});
test('official NotiSend status reader discards body/credentials and validates ID and enumerated state',async()=>{
  let url;
  const reader=body=>readNotisendStatus('123',{token:'synthetic-token',fetcher:async target=>{
    url=target;return {ok:true,json:async()=>body};}});
  assert.equal(await reader({id:123,status:'delivered',html:'private-password'}),'delivered');
  assert.equal(url,'https://api.notisend.ru/v1/email/messages/123');
  await assert.rejects(reader({id:456,status:'delivered'}),/INVALID/);
  await assert.rejects(reader({id:123,status:'opened'}),/INVALID/);
});

scenario('password viewing: exact account, repeatable, authenticated, CSRF protected, encrypted and audited',async()=>{
  await owner();
  const id=await order({id:'credential-one',tariff:'premium'});
  const second=await order({id:'credential-two',tariff:'premium'});
  const cookie=await login();
  const token=(await (await request('/api/admin/orders',{cookie})).json()).csrfToken;
  const path='/api/admin/orders/'+id+'/password';
  const password=premiumPasswordForOrder(id,key);
  assert.equal((await request(path,{method:'POST',body:{}})).status,401);
  await member('ordinary@example.test');
  const ordinary=await login('ordinary@example.test');
  assert.equal((await request(path,{method:'POST',cookie:ordinary,body:{},token})).status,403);
  assert.equal((await request(path,{method:'POST',cookie,body:{}})).status,403);
  assert.equal((await request(path,{method:'POST',cookie,body:{},token,origin:'https://evil.example.test'})).status,403);
  for(let n=0;n<2;n++){
    const response=await request(path,{method:'POST',cookie,body:{},token});
    assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);
    assert.deepEqual(await response.json(),{ok:true,password,loginEmail:'buyer@example.test'});
  }
  const other=await request('/api/admin/orders/'+second+'/password',{method:'POST',cookie,body:{},token});
  assert.equal((await other.json()).password,premiumPasswordForOrder(second,key));
  assert.notEqual(premiumPasswordForOrder(second,key),password);
  const detailText=await (await request('/api/admin/orders/'+id,{cookie})).text();
  assert.ok(!detailText.includes(password));assert.ok(!detailText.includes('password_ciphertext'));
  const vault=(await pool.query('SELECT password_ciphertext FROM club_admin_credentials WHERE user_key=$1',['order:'+id])).rows[0];
  assert.ok(vault.password_ciphertext);assert.ok(!vault.password_ciphertext.includes(password));
  const audit=(await pool.query('SELECT action FROM club_admin_audit WHERE order_id=$1',[id])).rows;
  assert.deepEqual(audit.map(x=>x.action),['password:view','password:view']);
  assert.ok(!JSON.stringify(audit).includes(password));
  await pool.query('UPDATE club_users SET password_hash=$2 WHERE email=$1',['order:'+id,await hash('synthetic-changed-password')]);
  const stale=await request(path,{method:'POST',cookie,body:{},token});
  assert.equal(stale.status,409);assert.ok(!(await stale.text()).includes(password));
  await pool.query("UPDATE club_cp_orders SET last_payment_status='refund_reported' WHERE order_id=$1",[second]);
  assert.equal((await request('/api/admin/orders/'+second+'/password',{method:'POST',cookie,body:{},token})).status,409);
});

scenario('password reset: explicit request only, revokes sessions, preserves payment, queues email and remains readable',async()=>{
  await owner();
  const id=await order({id:'credential-reset',tariff:'premium'});
  const oldPassword=premiumPasswordForOrder(id,key);
  await login('buyer@example.test',oldPassword);
  const cookie=await login();
  const token=(await (await request('/api/admin/orders',{cookie})).json()).csrfToken;
  const path='/api/admin/orders/'+id+'/reset-password';
  const input={confirmRequested:true,expectedAttempts:1,expectedMessageId:'message-'+id};
  assert.equal((await request(path,{method:'POST',cookie,token,body:{...input,confirmRequested:false}})).status,400);
  assert.equal((await request(path,{method:'POST',cookie,token,body:{...input,expectedAttempts:99}})).status,409);
  const response=await request(path,{method:'POST',cookie,token,body:input});
  assert.equal(response.status,200);
  const changed=await response.json();
  assert.ok(changed.password.startsWith('Fz-'));assert.notEqual(changed.password,oldPassword);
  assert.equal(changed.emailQueued,true);
  assert.equal(Number((await pool.query('SELECT count(*) AS n FROM club_sessions WHERE email=$1',['order:'+id])).rows[0].n),0);
  const previous=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({email:'buyer@example.test',password:oldPassword})});
  assert.equal(previous.status,401);
  await login('buyer@example.test',changed.password);
  const paid=(await pool.query('SELECT status,amount_cents FROM club_cp_orders WHERE order_id=$1',[id])).rows[0];
  assert.equal(paid.status,'paid');assert.equal(Number(paid.amount_cents),599000);
  // Even after the sending queue clears its transient credential, the encrypted vault remains available.
  await pool.query("UPDATE club_cp_access_mail SET password_ciphertext=NULL,state='accepted',provider='notisend',provider_message_id='synthetic-reset' WHERE order_id=$1",[id]);
  const repeated=await request('/api/admin/orders/'+id+'/password',{method:'POST',cookie,token,body:{}});
  assert.equal((await repeated.json()).password,changed.password);
  const detail=await (await request('/api/admin/orders/'+id,{cookie})).json();
  const resend=await request('/api/admin/orders/'+id+'/resend',{method:'POST',cookie,token,
    body:{reason:'customer_request',expectedAttempts:detail.order.attempts,expectedMessageId:detail.order.provider_message_id}});
  assert.equal(resend.status,200);
  assert.ok(!JSON.stringify((await pool.query('SELECT * FROM club_admin_audit')).rows).includes(changed.password));
});

scenario('browser: password can be reopened, reset is confirmed, desktop and phone widths do not overflow',async()=>{
  const {chromium}=await import('playwright');
  const {mkdir}=await import('node:fs/promises');
  await owner();
  const id=await order({id:'credential-browser',tariff:'premium'});
  const password=premiumPasswordForOrder(id,key);
  const browser=await chromium.launch({executablePath:process.env.CLUB_TEST_CHROMIUM,headless:true,
    args:['--no-sandbox','--disable-dev-shm-usage']});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    await page.route('**/*',async route=>{
      const target=new URL(route.request().url());
      if(target.origin!=='https://club.example.test')return route.abort();
      const response=await route.fetch({url:base+target.pathname+target.search});await route.fulfill({response});
    });
    await page.goto('https://club.example.test/admin');
    await page.evaluate(()=>fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({email:'owner@example.test',password:'synthetic-test-password'})}));
    await page.goto('https://club.example.test/admin');
    await page.locator('.order-row').first().click();
    await page.locator('#viewPasswordButton').click();
    await page.waitForFunction(expected=>document.querySelector('#credentialValue').textContent===expected,password);
    if(process.env.CLUB_TEST_SCREENSHOT_DIR){
      await mkdir(process.env.CLUB_TEST_SCREENSHOT_DIR,{recursive:true});
      await page.screenshot({path:process.env.CLUB_TEST_SCREENSHOT_DIR+'/password-desktop.jpg',type:'jpeg',quality:80});
    }
    await page.locator('#closeDialog').click();
    assert.equal(await page.locator('#credentialValue').textContent(),'');
    await page.locator('.order-row').first().click();
    await page.locator('#viewPasswordButton').click();
    await page.waitForFunction(expected=>document.querySelector('#credentialValue').textContent===expected,password);
    await page.locator('#resetPasswordButton').click();
    await page.locator('#cancelPasswordReset').click();
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM club_admin_audit WHERE action='password:reset'")).rows[0].n,0);
    await page.locator('#resetPasswordButton').click();
    await page.locator('#resetRequested').check();
    await page.locator('#confirmPasswordReset').click();
    await page.waitForFunction(previous=>{
      const value=document.querySelector('#credentialValue').textContent;
      return value.startsWith('Fz-')&&value!==previous&&!document.querySelector('#resetPasswordDialog').open;
    },password);
    const resetPassword=await page.locator('#credentialValue').textContent();
    await page.setViewportSize({width:390,height:844});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(process.env.CLUB_TEST_SCREENSHOT_DIR)
      await page.screenshot({path:process.env.CLUB_TEST_SCREENSHOT_DIR+'/password-mobile.jpg',type:'jpeg',quality:80});
    await page.locator('#closeDialog').click();
    await page.locator('.order-row').first().click();
    await page.locator('#viewPasswordButton').click();
    await page.waitForFunction(expected=>document.querySelector('#credentialValue').textContent===expected,resetPassword);
    assert.ok(!await page.evaluate(value=>JSON.stringify(localStorage).includes(value),resetPassword));
  }finally{await browser.close();}
});

scenario('browser: real session, attention/search/detail/confirmed resend, safe text and responsive layout',async()=>{
  assert.ok(process.env.CLUB_TEST_CHROMIUM,'Set CLUB_TEST_CHROMIUM to the test browser executable');
  const {chromium}=await import('playwright');
  const {mkdir}=await import('node:fs/promises');
  await owner();
  await order({id:'browser-bounce'});
  await order({id:'browser-delivered',status:'delivered'});
  await pool.query("UPDATE club_cp_orders SET buyer_name='<img src=x onerror=window.pwned=1>' WHERE order_id='browser-bounce'");
  const browser=await chromium.launch({executablePath:process.env.CLUB_TEST_CHROMIUM,
    headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    await page.route('**/*',async route=>{
      const target=new URL(route.request().url());
      if(target.origin!=='https://club.example.test')return route.abort();
      const response=await route.fetch({url:base+target.pathname+target.search});
      await route.fulfill({response});
    });
    await page.goto('https://club.example.test/admin');
    const status=await page.evaluate(async()=>{
      const response=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({email:'owner@example.test',password:'synthetic-test-password'})});
      return response.status;
    });
    assert.equal(status,200);
    await page.goto('https://club.example.test/admin');
    await page.locator('.order-row').first().waitFor();
    assert.match(await page.locator('#paymentProviderNotice').innerText(),/Новые оплаты: Prodamus/);
    assert.equal(await page.locator('.order-row').count(),1);
    assert.equal(await page.evaluate(()=>window.pwned),undefined);
    assert.equal(await page.locator('.buyer-name').innerText(),'<img src=x onerror=window.pwned=1>');
    await page.getByRole('button',{name:'Все заказы',exact:true}).click();
    await page.waitForFunction(()=>document.querySelectorAll('.order-row').length===2);
    if(process.env.CLUB_TEST_SCREENSHOT_DIR){
      await mkdir(process.env.CLUB_TEST_SCREENSHOT_DIR,{recursive:true});
      await page.screenshot({path:process.env.CLUB_TEST_SCREENSHOT_DIR+'/desktop.jpg',type:'jpeg',quality:80});
    }
    await page.locator('#searchInput').fill('browser-bounce');
    await page.locator('#searchForm button').click();
    await page.waitForFunction(()=>document.querySelectorAll('.order-row').length===1);
    await page.locator('.order-row').click();
    await page.locator('#resendButton').waitFor({state:'visible'});
    await page.locator('#resendButton').click();
    assert.equal((await pool.query("SELECT state FROM club_cp_access_mail WHERE order_id='browser-bounce'")).rows[0].state,'accepted');
    await page.locator('#confirmResend').click();
    await page.waitForFunction(()=>!document.querySelector('#resendDialog').open);
    assert.equal((await pool.query("SELECT state FROM club_cp_access_mail WHERE order_id='browser-bounce'")).rows[0].state,'pending');
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.locator('#paymentProviderNotice').isVisible(),true);
    await page.locator('#searchInput').fill('');
    await page.locator('#searchForm button').click();
    await page.waitForFunction(()=>document.querySelectorAll('.order-row').length===2);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    if(process.env.CLUB_TEST_SCREENSHOT_DIR)
      await page.screenshot({path:process.env.CLUB_TEST_SCREENSHOT_DIR+'/mobile.jpg',type:'jpeg',quality:80,fullPage:true});
  }finally{await browser.close();}
});

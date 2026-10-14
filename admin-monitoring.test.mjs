import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import express from 'express';
import {CLOUD_SCHEMA} from './cloudpayments-store.mjs';
import {MAIL_MONITOR_SCHEMA} from './mail-monitor.mjs';
import {ADMIN_SCHEMA,CHECKOUT_PROVIDER_SCHEMA,createAdminStore} from './admin-store.mjs';
import {HISTORY_SCHEMA,createPaymentHistory} from './payment-history.mjs';
import {mountAdmin} from './admin-access.mjs';
import {digest} from './history-csv.mjs';

const dsn=process.env.CLOUDPAYMENTS_TEST_DB_URL;
const schema='monitoring_'+crypto.randomBytes(6).toString('hex');
let root,pool,server,base,history,admin;
const scenario=(name,fn)=>test(name,{skip:!dsn},fn);
before(async()=>{
  if(!dsn)return;
  const url=new URL(dsn);
  assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/club_cloudpayments_test');
  root=new pg.Pool({connectionString:dsn,ssl:false});
  await root.query('CREATE SCHEMA '+schema);
  pool=new pg.Pool({connectionString:dsn,ssl:false,options:'-c search_path='+schema});
  await pool.query('CREATE TABLE club_users(email TEXT PRIMARY KEY,login_email TEXT,name TEXT)');
  await pool.query("INSERT INTO club_users VALUES('owner','owner@example.test','Тестовый администратор'),('buyer','login@example.test','Участник')");
  for(const sql of [...CLOUD_SCHEMA,...MAIL_MONITOR_SCHEMA,...ADMIN_SCHEMA,...CHECKOUT_PROVIDER_SCHEMA,...HISTORY_SCHEMA])await pool.query(sql);
  await pool.query("INSERT INTO club_admin_accounts(user_key) VALUES('owner')");
  history=createPaymentHistory(pool);admin=createAdminStore(pool);
  const app=express();app.use(express.json());
  mountAdmin(app,express,{enabled:true,cloudEnabled:true,paymentProvider:()=> 'prodamus',historyStore:history,store:admin,
    findSession:async req=>req.get('x-test-user')?{user_key:req.get('x-test-user'),name:'Тестовый администратор'}:null,
    siteUrl:'https://club.example.test',key:'synthetic-monitoring-key-only'});
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  base='http://127.0.0.1:'+server.address().port;
});
beforeEach(async()=>{
  if(dsn)await pool.query('TRUNCATE club_cp_orders,club_payment_history,club_history_events CASCADE');
});
after(async()=>{
  if(server)await new Promise(r=>server.close(r));
  if(pool)await pool.end();
  if(root){await root.query('DROP SCHEMA '+schema+' CASCADE');await root.end();}
});
async function order(id,{provider='prodamus',testMode=false,paymentStatus='paid',amount=100000}={}){
  await pool.query(`INSERT INTO club_cp_orders(order_id,buyer_email,buyer_name,tariff,amount_cents,test_mode,
    payment_provider,status,last_payment_status,paid_at) VALUES($1,'payer@example.test','Тестовый участник',
    'premium',$2,$3,$4,'paid',$5,now())`,[id,amount,testMode,provider,paymentStatus]);
}
async function mail(id,status='unknown',code='external_delivery_unverified'){
  await pool.query(`INSERT INTO club_cp_access_mail(order_id,user_key,state,provider,delivery_status,last_error_code,provider_message_id)
    VALUES($1,'buyer','blocked',$2,$3,$4,$5)`,[id,code==='external_delivery_unverified'?'prodamus':'notisend',
      status,code,code==='external_delivery_unverified'?null:'message-'+id]);
}
async function ledger(id,status='paid',amount=100000,{provider='prodamus',orderId=null,conflict=false,age=0,currency='RUB'}={}){
  await pool.query(`INSERT INTO club_payment_history(id,provider,provider_id,order_id,buyer_email,amount_cents,
    currency,tariff,status,source_status,occurred_at,source,identity_conflict)
    VALUES($1,$2,$3,$4,'payer@example.test',$5,$6,'premium',$7,$7,now()-make_interval(days=>$8),'csv',$9)`,
  [digest(provider+':'+id),provider,id,orderId,amount,currency,status,age,conflict]);
}
async function event(id,orderId,type='fail',{txn=id,original=null,code=null,age=0}={}){
  await pool.query(`INSERT INTO club_cp_payment_events(event_id,order_id,payment_provider,event_type,
    provider_status,transaction_id,error_code,amount_cents,currency,created_at,original_transaction_id)
    SELECT $1,order_id,payment_provider,$3,$3,$4,$5,amount_cents,'RUB',now()-make_interval(days=>$6),$7
    FROM club_cp_orders WHERE order_id=$2`,[id,orderId,type,txn,code,age,original]);
}
scenario('queue separates proved errors from unobservable delivery; keeps source evidence and identity',async()=>{
  await order('native');await mail('native');
  await order('uncertain');await mail('uncertain','unknown','send_uncertain');
  await order('bounce');await mail('bounce','soft_bounced',null);
  await order('payment-fail',{paymentStatus:'failed'});await mail('payment-fail');
  await order('missing-access');
  await order('accepted');await mail('accepted','delivered',null);
  await pool.query("UPDATE club_cp_access_mail SET state='accepted' WHERE order_id='accepted'");
  await order('test-only',{testMode:true,paymentStatus:'failed'});
  const list=await admin.list();
  assert.deepEqual(list.summary,{attention:3,delivered:1,unverified:2,inProgress:0});
  assert.deepEqual(list.orders.map(x=>x.order_id),['payment-fail','missing-access','bounce']);
  const unknown=await admin.list({filter:'unverified'});
  assert.equal(unknown.total,2);assert.ok(unknown.generatedAt);
  const native=unknown.orders.find(x=>x.order_id==='native');
  assert.match(native.queue_reason,/не передаёт/);assert.match(native.next_action,/участника/);
  assert.equal(native.recipient_email,'login@example.test');assert.equal(native.buyer_email,'payer@example.test');
  assert.equal(native.delivery_status,'unknown');assert.equal(native.needs_attention,true);
  assert.equal((await admin.detail('native')).order.queue_category,'unverified');
});
scenario('archive order link fails closed on identity conflicts, different amount/email and currency',async()=>{
  await order('match');await mail('match');
  await ledger('match','paid',100000,{orderId:'match'});
  assert.equal((await history.detail(digest('prodamus:match'))).live_order_id,'match');
  await pool.query("UPDATE club_payment_history SET identity_conflict=true");
  const blocked=await history.detail(digest('prodamus:match'));
  assert.equal(blocked.live_order_id,null);assert.equal(blocked.mail_status,'not_verified');
  await pool.query("UPDATE club_payment_history SET identity_conflict=false,buyer_email='other@example.test'");
  assert.equal((await history.detail(digest('prodamus:match'))).live_order_id,null);
  await pool.query("UPDATE club_payment_history SET buyer_email='payer@example.test',currency='USD'");
  assert.equal((await history.detail(digest('prodamus:match'))).live_order_id,null);
});
scenario('analytics deduplicates observations, excludes leads/tests/conflicts, respects windows and refunds',async()=>{
  await ledger('one','paid',100000);await ledger('two','settled',200000);
  await ledger('old','paid',400000,{age:45});
  await ledger('return','refunded',300000);await ledger('partial','partially_refunded',100000);
  await ledger('conflict','paid',900000,{conflict:true});
  await order('test-order',{testMode:true});await ledger('test','paid',999000,{orderId:'test-order'});
  await order('cloud',{provider:'cloudpayments',amount:500000});
  await pool.query("INSERT INTO club_cp_payments VALUES('cp-paid','cloud','fulfilled',now())");
  await ledger('cp-paid','paid',500000,{provider:'cloudpayments',orderId:'cloud'});
  await order('cloud-return',{provider:'cloudpayments',amount:700000});
  await pool.query("INSERT INTO club_cp_payments VALUES('cp-return','cloud-return','fulfilled',now())");
  await event('return-reported','cloud-return','refund',{txn:'cp-return'});
  await order('decline');await event('fail-a','decline','fail',{txn:'same-attempt',code:'5051'});
  await event('fail-b','decline','fail',{txn:'same-attempt',code:'5051'});
  await ledger('same-attempt','failed',100000);
  await event('unknown-reason','decline','fail',{txn:null});
  await event('not-a-failure','decline','unknown');
  await event('canceled','decline','cancel');
  await event('old-failure','decline','fail',{age:45});
  await event('test-failure','test-order');
  await order('cloud-decline',{provider:'cloudpayments'});
  await event('unsafe-code','cloud-decline','fail',{code:'provider body with private data'});
  await ledger('historic-failed','failed',100000);
  await pool.query(`INSERT INTO club_history_events(id,record_key,kind,provider,provider_id,order_id,buyer_email,
    amount_cents,currency,tariff,status,source_status,occurred_at,source,occurrences)
    VALUES('lead','lead','lead','prodamus','lead',NULL,'payer@example.test',100000,'RUB','premium','lead',
    'Отказ в рассрочке',now(),'csv',100)`);
  const report=await history.analytics({period:'7'});
  assert.equal(report.collection.amount_cents,'800000');assert.equal(report.collection.count,3);
  assert.deepEqual(report.collection.refunds,{full_count:1,partial_count:1,reported_count:1});
  assert.equal(report.excluded.identity_conflicts,1);assert.equal(report.failures.count,4);
  assert.equal(report.failures.groups.find(g=>g.reason_code==='5051').count,1);
  assert.ok(report.failures.groups.some(g=>g.label==='Причина не передана'));
  assert.doesNotMatch(JSON.stringify(report),/payer@|login@|private data|ciphertext|password/);
  assert.equal((await history.analytics({period:'all'})).collection.amount_cents,'1200000');
  assert.equal((await history.analytics({period:'30'})).collection.amount_cents,'800000');
  assert.equal((await history.analytics({period:"7' OR 1=1"})).period,'30');
  await pool.query("DELETE FROM club_payment_history WHERE provider='cloudpayments'");
  assert.equal((await history.analytics({period:'7'})).collection.amount_cents,'800000');
  assert.equal((await pool.query('SELECT count(*)::int n FROM club_cp_payments')).rows[0].n,2);
  assert.equal((await pool.query('SELECT count(*)::int n FROM club_cp_access_mail')).rows[0].n,0);
});
scenario('imported paid transactions respect later reversals in totals, daily charts, providers and refund counters',async()=>{
  await order('imported-cloud',{provider:'cloudpayments',amount:500000});
  await pool.query("INSERT INTO club_cp_payments VALUES('imported-txn','imported-cloud','fulfilled',now())");
  await ledger('imported-txn','paid',500000,{provider:'cloudpayments',orderId:'imported-cloud'});
  const before=await history.analytics({period:'7'});
  assert.equal(before.collection.amount_cents,'500000');
  assert.equal(before.collection.daily[0].amount_cents,'500000');
  // A different transaction on the same order must not reverse this charge.
  await event('unrelated-refund','imported-cloud','refund',{txn:'other-charge'});
  assert.equal((await history.analytics({period:'7'})).collection.amount_cents,'500000');
  // Refund transaction ID is not the original paid transaction ID.
  await event('imported-refund','imported-cloud','refund',{txn:'refund-transaction',original:'imported-txn'});
  await event('late-paid','imported-cloud','pay',{txn:'imported-txn'});
  for(const period of ['7','30','all']){
    const after=await history.analytics({period});
    assert.equal(after.collection.amount_cents,'0');assert.equal(after.collection.count,0);
    assert.deepEqual(after.collection.daily,[]);assert.deepEqual(after.collection.by_provider,[]);
    assert.deepEqual(after.collection.refunds,{full_count:0,partial_count:0,reported_count:1});
  }
  // An archive row without a site-order number still matches the unique fulfilled transaction.
  await pool.query("UPDATE club_payment_history SET order_id=NULL WHERE provider_id='imported-txn'");
  assert.equal((await history.analytics({period:'7'})).collection.amount_cents,'0');
  await pool.query("UPDATE club_payment_history SET status='partially_refunded' WHERE provider_id='imported-txn'");
  assert.deepEqual((await history.analytics({period:'7'})).collection.refunds,
    {full_count:0,partial_count:1,reported_count:0});
  // Imported Prodamus reversals use the same read-only projection.
  await order('imported-native');
  await ledger('native-txn','paid',100000,{orderId:'imported-native'});
  await event('native-refund','imported-native','refund',{txn:'native-txn'});
  await order('imported-canceled',{provider:'cloudpayments',amount:300000});
  await pool.query("INSERT INTO club_cp_payments VALUES('cancel-txn','imported-canceled','fulfilled',now())");
  await ledger('cancel-txn','paid',300000,{provider:'cloudpayments',orderId:'imported-canceled'});
  await event('imported-cancel','imported-canceled','cancel',{txn:'cancel-txn'});
  const final=await history.analytics({period:'7'});
  assert.equal(final.collection.amount_cents,'0');assert.deepEqual(final.collection.daily,[]);
  assert.deepEqual(final.collection.refunds,{full_count:0,partial_count:1,reported_count:1});
  // Projection never rewrites the imported evidence or fulfillment ledgers.
  assert.equal((await pool.query("SELECT status FROM club_payment_history WHERE provider_id='native-txn'")).rows[0].status,'paid');
  assert.equal((await pool.query('SELECT count(*)::int n FROM club_cp_access_mail')).rows[0].n,0);
});
scenario('analytics and assets require exact admin role, no-store, read-only methods',async()=>{
  for(const path of ['/api/admin/analytics','/admin/analytics.js']){
    assert.equal((await fetch(base+path)).status,401);
    assert.equal((await fetch(base+path,{headers:{'x-test-user':'buyer'}})).status,403);
    const response=await fetch(base+path,{headers:{'x-test-user':'owner'}});
    assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);
  }
  const response=await fetch(base+'/api/admin/analytics',{method:'POST',headers:{'x-test-user':'owner'}});
  assert.notEqual(response.status,200);
  const list=await history.list();
  assert.ok(list.generatedAt);assert.equal(list.coverage.earliest,null);
});
scenario('browser desktop/mobile: real queue, charts, email difference, archive link and paused refresh',async()=>{
  const {chromium}=await import('playwright');
  await order('native');await mail('native');await ledger('linked','paid',100000,{orderId:'native'});
  await ledger('conflicted','paid',500000,{orderId:'native',conflict:true});
  await event('example-decline','native','fail',{txn:'declined-before-retry',code:'5051'});
  await event('example-unspecified','native','fail',{txn:'other-attempt'});
  const browser=await chromium.launch({executablePath:process.env.CLUB_TEST_CHROMIUM,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const errors=[];
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1000},extraHTTPHeaders:{'x-test-user':'owner'}});
    await page.clock.install();
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/admin/');
    await page.waitForFunction(()=>document.querySelector('#summaryAttention').textContent==='0');
    await page.waitForFunction(()=>document.querySelectorAll('#analyticsRegion svg').length===2);
    assert.match(await page.locator('#analyticsRegion').textContent(),/5051/);
    assert.match(await page.locator('#analyticsRegion').textContent(),/Причина не передана/);
    for(const period of ['7','all','30']){
      await page.locator('[data-period="'+period+'"]').click();
      await page.waitForFunction(()=>document.querySelector('#analyticsRegion').getAttribute('aria-busy')==='false');
      assert.match(await page.locator('.chart-total-value').textContent(),/1[\s\u00a0]000/);
    }
    const bar=page.locator('.daily-bars .chart-bar').first();
    assert.match(await bar.getAttribute('aria-label'),/2026.*1[\s\u00a0]000/);
    await bar.hover();
    assert.equal(await page.locator('.chart-hover-value').isVisible(),true);
    assert.match(await page.locator('.chart-hover-value').textContent(),/2026.*1[\s\u00a0]000.*1 оплата/);
    if(process.env.CLUB_TEST_SCREENSHOT_DIR)
      await page.locator('.collection-chart-card').screenshot({
        path:process.env.CLUB_TEST_SCREENSHOT_DIR+'/hover-desktop.jpg',type:'jpeg',quality:85});
    await page.mouse.move(0,0);
    assert.equal(await page.locator('.chart-hover-value').isVisible(),false);
    await bar.focus();
    assert.equal(await page.locator('.chart-hover-value').isVisible(),true);
    const touch=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,extraHTTPHeaders:{'x-test-user':'owner'}});
    try{
      await touch.goto(base+'/admin/');
      await touch.locator('.daily-bars .chart-bar').first().tap();
      assert.equal(await touch.locator('.chart-hover-value').isVisible(),true);
      assert.match(await touch.locator('.chart-hover-value').textContent(),/2026.*1[\s\u00a0]000/);
      assert.equal(await touch.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      if(process.env.CLUB_TEST_SCREENSHOT_DIR)
        await touch.locator('.collection-chart-card').screenshot({
          path:process.env.CLUB_TEST_SCREENSHOT_DIR+'/hover-mobile.jpg',type:'jpeg',quality:85});
    }finally{await touch.close();await page.bringToFront();}
    await page.route('**/api/admin/analytics?period=7',async route=>{
      const response=await route.fetch();
      const report=await response.json();
      report.collection.amount_cents='123456';
      report.collection.count=2;
      report.collection.daily=[{day:'2026-10-14',amount_cents:'123456',count:2}];
      report.collection.by_provider=[{provider:'prodamus',amount_cents:'123456',count:2}];
      await route.fulfill({response,json:report});
    });
    await page.locator('[data-period="7"]').click();
    await page.waitForFunction(()=>document.querySelector('#analyticsRegion')?.getAttribute('aria-busy')==='false');
    await page.locator('.daily-bars .chart-bar').first().hover();
    assert.match(await page.locator('.chart-total-value').textContent(),/1[\s\u00a0]234,56/);
    assert.match(await page.locator('.chart-hover-value').textContent(),/2026.*1[\s\u00a0]234,56.*2 оплаты/);
    await page.unroute('**/api/admin/analytics?period=7');
    await page.locator('[data-period="30"]').click();
    await page.waitForFunction(()=>document.querySelector('#analyticsRegion')?.getAttribute('aria-busy')==='false');
    await page.locator('[data-filter="unverified"]').click();
    await page.waitForFunction(()=>document.querySelectorAll('.order-row').length===1);
    assert.match(await page.locator('.order-row').textContent(),/payer@example.test/);
    assert.match(await page.locator('.order-row').textContent(),/login@example.test/);
    await page.locator('.order-row').click();
    await page.waitForFunction(()=>document.querySelector('#detailContent').textContent.includes('не передаёт'));
    let polls=0;page.on('request',r=>{if(r.url().includes('/api/admin/orders?'))polls++;});
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(150);assert.equal(polls,0);
    await page.clock.fastForward(195000);
    assert.equal(await page.locator('#freshnessLabel').evaluate(n=>n.classList.contains('is-stale')),true);
    assert.equal(polls,0);
    await page.clock.setSystemTime(new Date());
    await page.locator('#closeDialog').click();
    await page.locator('#searchInput').fill('несохранённый поиск');
    await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(150);assert.equal(polls,0);
    await page.goto(base+'/admin/history');
    await page.waitForFunction(()=>document.querySelectorAll('.history-row').length===2);
    // Open the exact matching non-conflicting record through its real detail API.
    await page.locator('.history-row').last().click();
    await page.waitForFunction(()=>document.querySelector('#detailContent').textContent.includes('Связанный заказ'));
    const link=page.locator('#detailContent a[href*="order="]');
    if(await link.count()){await link.click();
      await page.waitForFunction(()=>document.querySelector('#orderDialog').open&&document.querySelector('#detailContent').textContent.includes('не передаёт'));}
    else{throw new Error('Exact matched archive record must link to live order');}
    await page.locator('#closeDialog').click();
    for(const width of [1440,390]){
      await page.setViewportSize({width,height:1000});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
      if(process.env.CLUB_TEST_SCREENSHOT_DIR){
        const {mkdir}=await import('node:fs/promises');await mkdir(process.env.CLUB_TEST_SCREENSHOT_DIR,{recursive:true});
        await page.screenshot({path:process.env.CLUB_TEST_SCREENSHOT_DIR+'/monitoring-'+width+'.jpg',type:'jpeg',quality:80,fullPage:true});
      }
    }
    assert.deepEqual(errors,[]);
  }finally{await browser.close();}
});

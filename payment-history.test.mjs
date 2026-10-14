import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import pg from 'pg';
import {normalizeExport,parseCsv,money,moscowDate,digest} from './history-csv.mjs';
import {HISTORY_SCHEMA,createPaymentHistory,mergeFinancialStatus} from './payment-history.mjs';
import {CLOUD_SCHEMA} from './cloudpayments-store.mjs';
import {MAIL_MONITOR_SCHEMA} from './mail-monitor.mjs';
import {ADMIN_SCHEMA,createAdminStore} from './admin-store.mjs';
import {mountAdmin} from './admin-access.mjs';

const headers=['ID заказа','Номер заказа','Дата','E-mail','Метод оплаты','Сумма','Список товаров','Статус','paid_content','optional'];
const csv=(rows,h=headers)=>'\uFEFF'+[h,...rows].map(r=>r.map(x=>'"'+String(x??'').replaceAll('"','""')+'"').join(';')).join('\r\n');
const payment=(status='Выплачен',id='1001',order='order-one')=>[id,order,'2026-10-13 10:11:12','buyer@example.test','Карта','5990.00','Клуб — Расширенный',status,'DO_NOT_IMPORT_SECRET'];
const leadHeaders=headers.slice(0,7).concat('Действие');
const lead=(action='Выбран метод оплаты')=>payment().slice(0,7).concat(action);

test('CSV handles BOM, newlines, semicolons, quotes and omitted optional tail',()=>{
  assert.deepEqual(parseCsv('a;b;c\r\n"x;y";"z""q";"line\nnext"\r\n1;2').rows,
    [['x;y','z"q','line\nnext'],['1','2','']]);
  assert.throws(()=>parseCsv('a;b\n"x;y'),/UNCLOSED/);
  assert.throws(()=>parseCsv('a;b\n1;2;3'),/INVALID_ROW_WIDTH/);
  assert.throws(()=>parseCsv('a;a\n1;2'),/INVALID_HEADERS/);
});
test('strict dates, exact cents, no source credentials, no inferred declined charges',()=>{
  assert.equal(money('5 990,01'),599001);
  assert.throws(()=>money('1.001'),/INVALID_AMOUNT/);
  assert.throws(()=>money('-5.00'),/INVALID_AMOUNT/);
  assert.equal(moscowDate('2026-10-13 10:11:12'),'2026-10-13T07:11:12.000Z');
  assert.throws(()=>moscowDate('2026-02-30 10:11:12'),/INVALID_DATE/);
  const p=normalizeExport(csv([payment()]),'payments');
  assert.equal(p.records[0].status,'settled');
  assert.ok(!JSON.stringify(p).includes('DO_NOT_IMPORT_SECRET'));
  assert.ok(!JSON.stringify(p).includes('paid_content'));
  const leads=normalizeExport(csv([lead(),lead(),lead('Отказ в рассрочке')],leadHeaders),'leads');
  assert.equal(leads.rows,3);assert.equal(leads.unique,2);assert.equal(leads.duplicates,1);
  assert.equal(leads.records[0].occurrences,2);
  assert.ok(leads.records.every(x=>x.kind==='lead'&&x.status==='lead'));
  assert.throws(()=>normalizeExport(csv([payment('НЕИЗВЕСТНО')]),'payments'),/UNKNOWN_SOURCE_STATUS/);
});
test('late payment callbacks cannot undo a refund or settlement',()=>{
  assert.equal(mergeFinancialStatus('refunded','paid'),'refunded');
  assert.equal(mergeFinancialStatus('partially_refunded','paid'),'partially_refunded');
  assert.equal(mergeFinancialStatus('settled','paid'),'settled');
  assert.equal(mergeFinancialStatus('failed','paid'),'paid');
});

const dsn=process.env.CLOUDPAYMENTS_TEST_DB_URL;
const schema='history_test_'+crypto.randomBytes(6).toString('hex');
let root,pool,store,server,base;
before(async()=>{
  if(!dsn)return;
  const u=new URL(dsn);
  if(u.hostname!=='127.0.0.1'||u.pathname!=='/club_cloudpayments_test')
    throw new Error('History tests require the isolated local PostgreSQL runner');
  root=new pg.Pool({connectionString:dsn,ssl:false});
  await root.query('CREATE SCHEMA '+schema);
  pool=new pg.Pool({connectionString:dsn,ssl:false,options:'-c search_path='+schema});
  await pool.query('CREATE TABLE club_users(email TEXT PRIMARY KEY,login_email TEXT,name TEXT)');
  await pool.query("INSERT INTO club_users VALUES('owner','owner@example.test','Владелец')");
  for(const sql of [...CLOUD_SCHEMA,...MAIL_MONITOR_SCHEMA,...ADMIN_SCHEMA,...HISTORY_SCHEMA])await pool.query(sql);
  await pool.query("INSERT INTO club_admin_accounts(user_key) VALUES('owner')");
  store=createPaymentHistory(pool);
  const app=express();app.use(express.json());
  mountAdmin(app,express,{enabled:true,cloudEnabled:true,historyStore:store,store:createAdminStore(pool),
    findSession:async req=>req.get('x-test-user')?{user_key:req.get('x-test-user'),name:'Тест'}:null,
    siteUrl:'https://club.example.test',key:'synthetic-history-test-key'});
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{
  if(server)await new Promise(r=>server.close(r));
  if(pool)await pool.end();
  if(root){await root.query('DROP SCHEMA '+schema+' CASCADE');await root.end();}
});
test('separate historical import, replay, refund protection, search and local catch-up',{skip:!dsn},async()=>{
  const payments=normalizeExport(csv([payment(),payment('Возвращен','1002','order-two')]),'payments');
  const leads=normalizeExport(csv([lead(),lead(),lead('Отказ в рассрочке')],leadHeaders),'leads');
  const first=await store.importExports(payments,leads);
  assert.equal(first.duplicateLeads,1);
  await store.importExports(payments,leads);
  const listed=await store.list();
  assert.equal(listed.total,2);assert.equal(listed.summary.paid,1);assert.equal(listed.summary.refunded,1);
  assert.equal(listed.summary.leads,2);
  assert.ok(listed.items.every(x=>x.mail_status==='not_verified'));
  assert.equal((await store.list({q:'1001'})).total,1);
  assert.equal((await store.list({q:"%' OR 1=1 --"})).total,0);
  assert.equal((await store.list({kind:'leads',status:'failed'})).total,2);
  assert.equal((await store.list({status:'refunded'})).total,1);
  const d=await store.detail(digest('prodamus:1001'));
  assert.ok(d.events.some(e=>e.kind==='lead'));
  const serialized=JSON.stringify((await pool.query('SELECT row_to_json(h) FROM club_history_events h')).rows);
  assert.ok(!serialized.includes('DO_NOT_IMPORT_SECRET'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM club_users')).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM club_cp_access_mail')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM club_cp_payments')).rows[0].n,0);
  await pool.query(`INSERT INTO club_cp_orders(order_id,buyer_email,tariff,amount_cents,test_mode,payment_provider,status)
    VALUES('order-one','buyer@example.test','premium',599000,false,'prodamus','paid'),
      ('test-order','test@example.test','premium',599000,true,'prodamus','paid')`);
  await pool.query(`INSERT INTO club_cp_payments(transaction_id,order_id,outcome)
    VALUES('prodamus:1001','order-one','fulfilled'),('prodamus:test','test-order','test')`);
  await pool.query("INSERT INTO club_cp_access_mail(order_id,delivery_status) VALUES('order-one','delivered')");
  const sync=await store.reconcile();assert.equal(sync.payments,1);assert.equal(sync.leads,1);
  assert.deepEqual(await store.reconcile(),{payments:0,leads:0});
  const updated=await store.detail(digest('prodamus:1001'));
  assert.equal(updated.item.status,'settled');assert.equal(updated.mail_status,'delivered');
  assert.equal((await store.list()).total,2);
  await store.observeProdamus({order_id:'1002',order_num:'order-two',customer_email:'buyer@example.test',
    payment_status:'success',sum:'5990.00',currency:'rub',date:'2026-10-14T10:00:00+03:00'},{tariff:'premium'});
  assert.equal((await store.detail(digest('prodamus:1002'))).item.status,'refunded');
  await store.observeProdamus({order_id:'1001',order_num:'conflicting-order',customer_email:'other@example.test',
    payment_status:'success',sum:'4990.00',date:'2026-10-14T11:00:00+03:00'},{tariff:'premium'});
  const conflict=(await store.detail(digest('prodamus:1001'))).item;
  assert.equal(conflict.identity_conflict,true);assert.equal(conflict.buyer_email,'buyer@example.test');
  assert.equal(conflict.order_id,'order-one');assert.equal(Number(conflict.amount_cents),599000);
});
test('history pages, assets, list and detail are admin-only and read-only',{skip:!dsn},async()=>{
  for(const path of ['/admin/history','/admin/history.js','/admin/history.css','/api/admin/history']){
    assert.equal((await fetch(base+path)).status,401);
    assert.equal((await fetch(base+path,{headers:{'x-test-user':'intruder'}})).status,403);
    assert.equal((await fetch(base+path,{headers:{'x-test-user':'owner'}})).status,200);
  }
  const good=await fetch(base+'/api/admin/history/'+digest('prodamus:1001'),{headers:{'x-test-user':'owner'}});
  assert.equal(good.status,200);assert.match(good.headers.get('cache-control'),/no-store/);
  assert.equal((await fetch(base+'/api/admin/history/not-an-id',{headers:{'x-test-user':'owner'}})).status,404);
  const response=await fetch(base+'/api/admin/history',{method:'POST',headers:{'x-test-user':'owner'}});
  assert.notEqual(response.status,200);
});

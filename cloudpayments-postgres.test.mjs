import test,{before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import {CLOUD_SCHEMA,createCloudStore,drainAccessMail} from './cloudpayments-store.mjs';
import {MAIL_MONITOR_SCHEMA} from './mail-monitor.mjs';

// ONLY a deliberately supplied, disposable local cluster. Never DATABASE_URL.
const dsn=process.env.CLOUDPAYMENTS_TEST_DB_URL;
const enabled=Boolean(dsn);
let pool,admin;
const schema='cp_test_'+crypto.randomBytes(8).toString('hex');
before(async()=>{
  if(!enabled)return;
  const url=new URL(dsn);
  if(url.hostname!=='127.0.0.1'||url.pathname!=='/club_cloudpayments_test')
    throw new Error('Only disposable loopback test DB is allowed');
  admin=new pg.Pool({connectionString:dsn});
  await admin.query('CREATE SCHEMA '+schema);
  pool=new pg.Pool({connectionString:dsn,options:'-c search_path='+schema});
  await pool.query('CREATE TABLE club_webhook_events (event_id TEXT PRIMARY KEY,payload JSONB NOT NULL)');
  for(const sql of [...CLOUD_SCHEMA,...MAIL_MONITOR_SCHEMA])await pool.query(sql);
  await pool.query('CREATE TABLE synthetic_grants (order_id TEXT PRIMARY KEY)');
});
beforeEach(async()=>{
  if(enabled)await pool.query('TRUNCATE club_cp_access_mail,club_cp_payments,club_cp_orders,club_webhook_events,synthetic_grants CASCADE');
});
after(async()=>{
  if(pool)await pool.end();
  if(admin){await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.end();}
});
async function issued({tariff='premium',testMode=false}={}){
  const store=createCloudStore(pool,{test:testMode,grantPremium:async(client,order)=>{
    await client.query('INSERT INTO synthetic_grants VALUES ($1)',[order.order_id]);
    return {userKey:'synthetic-user',ciphertext:'encrypted-fixture'};
  }});
  await store.saveOrder({order_id:'synthetic-order',customer_email:'buyer@example.test',
    customer_name:'Тестовый Участник',products:[{price:'1.00'}]},tariff);
  return store;
}
test('PostgreSQL: migrations, concurrent duplicates and distinct transactions grant once',{skip:!enabled},async()=>{
  const store=await issued();
  await Promise.all([store.fulfill('synthetic-order','123'),store.fulfill('synthetic-order','123')]);
  await store.fulfill('synthetic-order','456');
  const result=await pool.query(`SELECT
    (SELECT count(*) FROM synthetic_grants)::integer AS grants,
    (SELECT count(*) FROM club_cp_access_mail)::integer AS mails,
    (SELECT count(*) FROM club_cp_payments)::integer AS payments`);
  assert.deepEqual(result.rows[0],{grants:1,mails:1,payments:2});
});
test('PostgreSQL: payment commit survives mail failure; lease/backoff and retry work',{skip:!enabled},async()=>{
  const store=await issued();await store.fulfill('synthetic-order','123');
  await drainAccessMail(pool,async()=>{throw new Error('synthetic mail outage');});
  const failed=await pool.query('SELECT state,attempts,next_attempt_at>now() AS delayed FROM club_cp_access_mail');
  assert.deepEqual(failed.rows[0],{state:'pending',attempts:1,delayed:true});
  await pool.query("UPDATE club_cp_access_mail SET next_attempt_at=now()-interval '1 second'");
  await drainAccessMail(pool,async()=>{});
  const sent=await pool.query('SELECT state,password_ciphertext,accepted_at IS NOT NULL AS accepted FROM club_cp_access_mail');
  assert.deepEqual(sent.rows[0],{state:'accepted',password_ciphertext:null,accepted:true});
  assert.equal((await store.getOrder('synthetic-order')).status,'paid');
});
test('PostgreSQL: test payments leave no real entitlement or access mail',{skip:!enabled},async()=>{
  const store=await issued({testMode:true});await store.fulfill('synthetic-order','123');
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM synthetic_grants')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM club_webhook_events')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::integer AS n FROM club_cp_access_mail')).rows[0].n,0);
});

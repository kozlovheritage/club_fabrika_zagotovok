import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import {spawnSync} from 'node:child_process';
import {CHECKOUT_PROVIDER_SCHEMA,createAdminStore} from './admin-store.mjs';
import {CLOUD_SCHEMA,createCloudStore} from './cloudpayments-store.mjs';
import {MAIL_MONITOR_SCHEMA} from './mail-monitor.mjs';
import {createCloudService} from './cloudpayments-router.mjs';

const dsn=process.env.CLOUDPAYMENTS_TEST_DB_URL;
let root,pool;
const schema='manual_provider_'+crypto.randomBytes(6).toString('hex');
test('manual operator command refuses missing readiness without reaching a database or payment API',()=>{
  const result=spawnSync(process.execPath,['scripts/set-checkout-provider.mjs','--to','cloudpayments',
    '--expected','prodamus','--confirm-manual-switch'],{cwd:new URL('.',import.meta.url),
    env:{PATH:process.env.PATH},encoding:'utf8'});
  assert.equal(result.status,2);
  assert.match(result.stderr,/readiness settings are incomplete/);
});
before(async()=>{
  if(!dsn)return;
  const url=new URL(dsn);
  assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/club_cloudpayments_test');
  root=new pg.Pool({connectionString:dsn});
  await root.query('CREATE SCHEMA '+schema);
  pool=new pg.Pool({connectionString:dsn,options:'-c search_path='+schema});
  await pool.query('CREATE TABLE club_webhook_events(event_id TEXT PRIMARY KEY,payload JSONB NOT NULL)');
  for(const sql of [...CLOUD_SCHEMA,...MAIL_MONITOR_SCHEMA,...CHECKOUT_PROVIDER_SCHEMA])await pool.query(sql);
});
after(async()=>{
  if(pool)await pool.end();
  if(root){await root.query('DROP SCHEMA '+schema+' CASCADE');await root.end();}
});
test('manual switch is atomic, survives restart/default changes and never changes existing orders',{skip:!dsn},async()=>{
  const selector=createAdminStore(pool);
  await selector.initializeCheckoutProvider('prodamus');
  await selector.initializeCheckoutProvider('cloudpayments');
  assert.equal(await selector.activeCheckoutProvider(),'prodamus');
  const cp=createCloudStore(pool,{test:false,grantPremium:async()=>{throw Error('No grant expected');}});
  await cp.saveOrder({order_id:'immutable-cloud',customer_email:'synthetic@example.test',products:[{price:'1.00'}]},'basic');
  await selector.setCheckoutProvider('cloudpayments','prodamus');
  await assert.rejects(selector.setCheckoutProvider('prodamus','prodamus'));
  await selector.setCheckoutProvider('prodamus','cloudpayments');
  assert.equal((await cp.getOrder('immutable-cloud')).payment_provider,'cloudpayments');
  const history=await selector.checkoutProviderHistory();
  assert.equal(history.length,2);
  assert.equal(await selector.activeCheckoutProvider(),'prodamus');
  const operatorEnv={PATH:process.env.PATH,DATABASE_URL:dsn,PGSSL:'false',PGOPTIONS:'-c search_path='+schema,
    CLOUDPAYMENTS_ENABLED:'true',CLOUDPAYMENTS_MODE:'live',CLOUDPAYMENTS_PUBLIC_ID:'synthetic-only',
    CLOUDPAYMENTS_API_SECRET:'synthetic-only',CLOUDPAYMENTS_TERMINAL_MODE_CONFIRMED:'true',
    CLOUDPAYMENTS_RECEIPT_APPROVED:'true',CLOUDPAYMENTS_RECEIPT_PROVIDER:'synthetic-cashbox',
    CLOUDPAYMENTS_RECEIPT_TEMPLATE_JSON:'{"cloudpayments":{"synthetic":true}}',
    AUTH_EMAIL_PROVIDER:'notisend',NOTISEND_API_KEY:'synthetic-only',AUTH_FROM_EMAIL:'synthetic@example.invalid',
    AUTH_CREDENTIAL_KEY:'synthetic-operator-key-at-least-32-characters'};
  for(const [target,current] of [['cloudpayments','prodamus'],['prodamus','cloudpayments']]){
    const result=spawnSync(process.execPath,['scripts/set-checkout-provider.mjs','--to',target,
      '--expected',current,'--confirm-manual-switch'],{cwd:new URL('.',import.meta.url),env:operatorEnv,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.equal(JSON.parse(result.stdout).active,target);
  }
  assert.equal((await selector.checkoutProviderHistory()).length,4);
});
test('documented failure/refund/cancel payloads are recorded, signed, deduplicated and do not grant access',{skip:!dsn},async()=>{
  let grants=0;
  const store=createCloudStore(pool,{test:false,grantPremium:async()=>{grants++;return {};}});
  await store.saveOrder({order_id:'event-cloud',customer_email:'synthetic@example.test',products:[{price:'1.00'}]},'premium');
  const config={enabled:true,secret:'synthetic-only-key',test:false};
  const service=createCloudService(config,store);
  const notify=async(kind,payload)=>{
    const raw=Buffer.from(JSON.stringify(payload));
    const hmac=crypto.createHmac('sha256',config.secret).update(raw).digest('base64');
    return service.notification(kind,raw,'application/json',hmac);
  };
  const base={InvoiceId:'event-cloud',AccountId:'event-cloud',Amount:'1.00',TransactionId:'1001'};
  await notify('fail',{...base,Currency:'RUB',TestMode:0,OperationType:'Payment',ReasonCode:5051});
  assert.equal((await store.getOrder(base.InvoiceId)).last_payment_status,'failed');
  const refund={...base,TransactionId:'2001',PaymentTransactionId:'1001',OperationType:'Refund',Amount:'0.40'};
  await notify('refund',refund);await notify('refund',refund);
  assert.equal((await pool.query("SELECT count(*)::int n FROM club_cp_payment_events WHERE event_type='refund'")).rows[0].n,1);
  // A late Pay after a refund is held for review, not used to issue access.
  await notify('pay',{...base,Currency:'RUB',TestMode:0,Status:'Completed'});
  assert.equal(grants,0);
  assert.equal((await store.getOrder(base.InvoiceId)).status,'review');
  assert.equal((await store.getOrder(base.InvoiceId)).last_payment_status,'refund_reported');
  assert.equal((await pool.query('SELECT count(*)::int n FROM club_cp_access_mail')).rows[0].n,0);
  await notify('cancel',base); // Official Cancel has no TestMode/Currency.
  assert.equal((await store.getOrder(base.InvoiceId)).last_payment_status,'canceled');
  await assert.rejects(notify('refund',{...refund,TransactionId:'2002',Amount:'1e2'}));
  await store.saveOrder({order_id:'reversed-order-new-transaction',customer_email:'other@example.test',products:[{price:'1.00'}]},'premium');
  const other={...base,InvoiceId:'reversed-order-new-transaction',AccountId:'reversed-order-new-transaction'};
  await notify('refund',{...other,TransactionId:'4001',PaymentTransactionId:'3001',OperationType:'Refund'});
  await notify('pay',{...other,TransactionId:'3002',Currency:'RUB',TestMode:0,Status:'Completed'});
  assert.equal(grants,0);
  assert.equal((await store.getOrder(other.InvoiceId)).status,'review');
  assert.equal((await pool.query('SELECT count(*)::int n FROM club_cp_access_mail')).rows[0].n,0);
});

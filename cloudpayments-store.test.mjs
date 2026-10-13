import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudStore,drainAccessMail} from './cloudpayments-store.mjs';

function database({tariff='premium',testMode=false,legacy=false,grantError=false,review=false}={}){
  const state={order:{order_id:'synthetic-order',buyer_email:'test@example.test',
    tariff,status:'pending',test_mode:testMode},payments:new Map(),events:[],mail:[],grants:0,commits:0,rollbacks:0};
  const client={release(){},async query(sql,args=[]){
    if(sql==='BEGIN'||sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:0};
    if(sql==='COMMIT'){state.commits++;return {rows:[]};}
    if(sql==='ROLLBACK'){state.rollbacks++;return {rows:[]};}
    if(sql.startsWith('SELECT * FROM club_cp_orders'))return {rows:[state.order],rowCount:1};
    if(sql.startsWith('SELECT order_id FROM club_cp_payments')){
      const id=state.payments.get(args[0]);return {rows:id?[{order_id:id}]:[],rowCount:id?1:0};
    }
    if(sql.startsWith('SELECT 1 FROM club_webhook_events'))return {rows:legacy?[{}]:[],rowCount:legacy?1:0};
    if(sql.startsWith('INSERT INTO club_cp_payments')){state.payments.set(args[0],args[1]);state.outcome=args[2];}
    else if(sql.includes('INSERT INTO club_webhook_events'))state.events.push(args);
    else if(sql.includes('INSERT INTO club_cp_access_mail'))state.mail.push(args);
    else if(sql.includes('UPDATE club_cp_orders'))state.order.status=args[1];
    else throw new Error('Unexpected SQL in fixture: '+sql);
    return {rows:[],rowCount:1};
  }};
  const pool={connect:async()=>client};
  const store=createCloudStore(pool,{test:testMode,grantPremium:async()=>{
    state.grants++;if(grantError)throw new Error('hash failed');
    return review?{review:true}:{userKey:'order:synthetic-order',ciphertext:'encrypted-fixture'};
  }});
  return {state,store};
}
test('duplicate payment notification creates exactly one grant and one outbox item',async()=>{
  const {state,store}=database();
  await store.fulfill('synthetic-order','123');await store.fulfill('synthetic-order','123');
  assert.equal(state.grants,1);assert.equal(state.mail.length,1);assert.equal(state.events.length,1);
  await store.fulfill('synthetic-order','456');
  assert.equal(state.grants,1);assert.equal(state.mail.length,1);assert.equal(state.outcome,'duplicate');
});
test('basic payment queues a Telegram email but never creates a platform account',async()=>{
  const {state,store}=database({tariff:'basic'});
  await store.fulfill('synthetic-order','123');
  assert.equal(state.grants,0);assert.equal(state.mail.length,1);
  assert.equal(state.mail[0][1],null);assert.equal(state.mail[0][2],null);
});
test('test mode cannot grant real accounts, paid access markers or mail in a shared DB',async()=>{
  const {state,store}=database({testMode:true});
  await store.fulfill('synthetic-order','123');
  assert.equal(state.grants,0);assert.equal(state.mail.length,0);assert.equal(state.events.length,0);
  assert.equal(state.outcome,'test');
});
test('existing Prodamus fulfillment is not granted or emailed again',async()=>{
  const {state,store}=database({legacy:true});
  await store.fulfill('synthetic-order','123');
  assert.equal(state.grants,0);assert.equal(state.mail.length,0);assert.equal(state.outcome,'duplicate');
});
test('identity conflict is recorded for review, not password replacement or wrong-person mail',async()=>{
  const {state,store}=database({review:true});
  await store.fulfill('synthetic-order','123');
  assert.equal(state.order.status,'review');assert.equal(state.mail.length,0);assert.equal(state.events.length,0);
});
test('fulfillment failure rolls back and does not acknowledge a completed grant',async()=>{
  const {state,store}=database({grantError:true});
  await assert.rejects(store.fulfill('synthetic-order','123'));
  assert.equal(state.rollbacks,1);assert.equal(state.commits,0);assert.equal(state.mail.length,0);
});
test('transaction cannot be silently rebound to a different order',async()=>{
  const {state,store}=database();state.payments.set('123','other-order');
  await assert.rejects(store.fulfill('synthetic-order','123'));
  assert.equal(state.grants,0);assert.equal(state.rollbacks,1);
});
test('mail failure remains retryable without losing the payment or running fulfillment again',async()=>{
  const updates=[];let sent=0;
  const pool={async query(sql,args){
    if(sql.startsWith('WITH due'))return {rows:[{order_id:'synthetic-order'}]};
    if(sql.startsWith('SELECT * FROM club_cp_orders'))return {rows:[{status:'paid'}]};
    updates.push({sql,args});return {rows:[],rowCount:1};
  }};
  pool.connect=async()=>({query:pool.query.bind(pool),release(){}});
  await drainAccessMail(pool,async()=>{sent++;throw new Error('mail API timeout');});
  assert.equal(sent,1);assert.equal(updates.find(x=>x.sql.includes('consecutive_failures=consecutive_failures+1')).args[2],false);
  await drainAccessMail(pool,async()=>{sent++;});
  assert.equal(sent,2);assert.ok(updates.some(x=>x.sql.includes("state='accepted'")));
});
test('rotated credential is blocked for review instead of sending an obsolete password',async()=>{
  let update;
  const pool={async query(sql,args){
    if(sql.startsWith('WITH due'))return {rows:[{order_id:'synthetic-order'}]};
    if(sql.startsWith('SELECT * FROM club_cp_orders'))return {rows:[{status:'paid'}]};
    if(sql.includes('consecutive_failures=consecutive_failures+1'))update=args;
    return {rows:[],rowCount:1};
  }};
  pool.connect=async()=>({query:pool.query.bind(pool),release(){}});
  await drainAccessMail(pool,async()=>{const error=new Error('password changed');error.status=409;throw error;});
  assert.equal(update[2],true);
});

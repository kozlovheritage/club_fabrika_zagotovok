import test from 'node:test';
import assert from 'node:assert/strict';
import {AccountDeletionError,deleteMemberAccount} from './account-deletion.mjs';

function database({account={email:'order:unit',status:'active'},admin=false}={}){
  const calls=[];
  const client={
    async query(sql,values=[]){
      const normalized=sql.replace(/\s+/g,' ').trim();
      calls.push({sql:normalized,values});
      if(normalized.startsWith('SELECT email,status FROM club_users'))
        return {rows:account?[{...account}]:[],rowCount:account?1:0};
      if(normalized.startsWith('SELECT 1 FROM club_admin_accounts'))
        return {rows:admin?[{'?column?':1}]:[],rowCount:admin?1:0};
      return {rows:[],rowCount:1};
    },
    release(){},
  };
  return {calls,connect:async()=>client};
}

test('deletion tombstones the account, revokes sessions and blocks pending access mail only',async()=>{
  const pool=database();
  assert.deepEqual(await deleteMemberAccount(pool,'order:unit',{mailRuntimeEnabled:true,adminEnabled:true}),{ok:true});
  const sql=pool.calls.map(call=>call.sql);
  assert.ok(sql.some(statement=>statement.includes("SET status='deleted'")&&statement.includes('password_hash=NULL')));
  assert.ok(sql.some(statement=>statement.startsWith('DELETE FROM club_sessions')));
  assert.ok(sql.some(statement=>statement.includes('UPDATE club_cp_access_mail')&&statement.includes("THEN 'blocked'")));
  assert.ok(sql.includes('COMMIT'));
  assert.ok(!sql.some(statement=>/DELETE FROM (club_cp_orders|club_cp_payments|club_cp_payment_events|club_webhook_events)/.test(statement)));
});

test('account deletion refuses enabled administrator credentials without mutating the account',async()=>{
  const pool=database({admin:true});
  await assert.rejects(deleteMemberAccount(pool,'order:unit',{adminEnabled:true}),
    error=>error instanceof AccountDeletionError&&error.status===403);
  const sql=pool.calls.map(call=>call.sql);
  assert.ok(sql.includes('ROLLBACK'));
  assert.ok(!sql.some(statement=>statement.startsWith('UPDATE club_users')));
  assert.ok(!sql.some(statement=>statement.startsWith('DELETE FROM club_sessions')));
});

test('unknown account fails without changing records',async()=>{
  const pool=database({account:null});
  await assert.rejects(deleteMemberAccount(pool,'missing@example.test'),
    error=>error instanceof AccountDeletionError&&error.status===404);
  assert.ok(pool.calls.some(call=>call.sql==='ROLLBACK'));
  assert.ok(!pool.calls.some(call=>call.sql.startsWith('UPDATE club_users')));
});

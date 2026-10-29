export class AccountDeletionError extends Error {
  constructor(message,status=409){super(message);this.status=status;}
}

// Keep the account row and its primary key as a tombstone so payment/order
// history retains its existing identity. Authentication secrets and active
// sessions are erased; financial evidence is deliberately not touched.
export async function deleteMemberAccount(pool,userKey,{mailRuntimeEnabled=false,adminEnabled=false}={}){
  if(typeof userKey!=='string'||!userKey||userKey.length>320)
    throw new AccountDeletionError('Аккаунт не найден',404);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const account=(await client.query(
      'SELECT email,status FROM club_users WHERE email=$1 FOR UPDATE',[userKey]
    )).rows[0];
    if(!account)throw new AccountDeletionError('Аккаунт не найден',404);
    if(adminEnabled){
      const admin=await client.query(
        'SELECT 1 FROM club_admin_accounts WHERE user_key=$1 AND enabled FOR UPDATE',[userKey]
      );
      if(admin.rowCount)throw new AccountDeletionError('Административную учётную запись нельзя удалить через кабинет участника',403);
    }
    await client.query(`UPDATE club_users SET status='deleted',deleted_at=COALESCE(deleted_at,now()),name=NULL,login_email=NULL,
      password_hash=NULL,password_tag=NULL,credential_email_ciphertext=NULL,
      credential_claimed_at=NULL,updated_at=now() WHERE email=$1`,[userKey]);
    await client.query('DELETE FROM club_sessions WHERE email=$1',[userKey]);
    if(adminEnabled)
      await client.query('DELETE FROM club_admin_credentials WHERE user_key=$1',[userKey]);
    if(mailRuntimeEnabled){
      await client.query(`UPDATE club_cp_access_mail SET
        state=CASE WHEN state IN ('pending','sending') THEN 'blocked' ELSE state END,
        password_ciphertext=NULL,
        claim_token=NULL,claimed_at=NULL,
        last_error_code=CASE WHEN state IN ('pending','sending') THEN 'account_deleted' ELSE last_error_code END,
        status_claim_token=NULL,status_claimed_at=NULL,next_status_check_at=NULL
        WHERE user_key=$1`,[userKey]);
    }
    await client.query('COMMIT');
    return {ok:true};
  }catch(error){
    await client.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{client.release();}
}

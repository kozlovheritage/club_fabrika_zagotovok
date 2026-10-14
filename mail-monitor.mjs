import crypto from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';

export const PAYMENT_REVIEW_SQL=`EXISTS(SELECT 1 FROM club_cp_payment_events reversal
  WHERE reversal.order_id=o.order_id AND reversal.event_type IN ('refund','cancel','refund_failed'))`;

export const MAIL_STATUSES = ['queued','sent','delivered','skipped','soft_bounced','hard_bounced'];
export const MAIL_MONITOR_SCHEMA = [
  `ALTER TABLE club_cp_orders
    ADD COLUMN IF NOT EXISTS access_confirmed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS access_confirmed_by TEXT`,
  `ALTER TABLE club_cp_access_mail
    ADD COLUMN IF NOT EXISTS provider TEXT,
    ADD COLUMN IF NOT EXISTS provider_message_id TEXT,
    ADD COLUMN IF NOT EXISTS delivery_status TEXT,
    ADD COLUMN IF NOT EXISTS last_error_code TEXT,
    ADD COLUMN IF NOT EXISTS last_sent_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS status_checked_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS next_status_check_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS status_claim_token TEXT,
    ADD COLUMN IF NOT EXISTS status_claimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0`,
  `CREATE TABLE IF NOT EXISTS club_cp_mail_history (
    id UUID PRIMARY KEY, order_id TEXT NOT NULL REFERENCES club_cp_orders(order_id),
    provider TEXT, provider_message_id TEXT, recipient_email TEXT, status TEXT NOT NULL,
    error_code TEXT, sent_at TIMESTAMPTZ NOT NULL DEFAULT now(), checked_at TIMESTAMPTZ)`,
  `CREATE INDEX IF NOT EXISTS club_cp_mail_history_order ON club_cp_mail_history(order_id,sent_at DESC)`,
  `CREATE INDEX IF NOT EXISTS club_cp_mail_status_due ON club_cp_access_mail(next_status_check_at)
    WHERE state='accepted' AND provider='notisend'`,
  `CREATE TABLE IF NOT EXISTS club_mail_alert_state (
    id INTEGER PRIMARY KEY CHECK(id=1), active BOOLEAN NOT NULL DEFAULT false,
    last_sent_at TIMESTAMPTZ, claim_token TEXT, claimed_at TIMESTAMPTZ,retry_at TIMESTAMPTZ)`,
  `INSERT INTO club_mail_alert_state(id) VALUES(1) ON CONFLICT DO NOTHING`
];

export function safeMailError(error) {
  if(error?.uncertain)return 'send_uncertain';
  if (error?.status===409) return 'credentials_review';
  if ([401,403].includes(error?.status)) return 'provider_auth';
  if (error?.status===429) return 'provider_rate_limit';
  if (error?.permanent) return 'provider_rejected';
  return 'temporary_send_failure';
}
export function receiptMetadata(receipt) {
  const id=String(receipt?.messageId||'');
  const validId=/^[A-Za-z0-9_-]{1,100}$/.test(id);
  return {
    provider:['notisend','resend'].includes(receipt?.provider)?receipt.provider:null,
    messageId:validId?id:null,
    status:validId&&MAIL_STATUSES.includes(receipt?.status)?receipt.status:'unknown',
    recipient:/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(receipt?.recipient||'')?receipt.recipient:null
  };
}
// Acceptance and its durable provider ID are committed together. No message body
// (the provider response can contain the password) is ever stored or logged.
export async function recordMailAccepted(pool,mail,token,receipt) {
  const meta=receiptMetadata(receipt);
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const updated=await client.query(`UPDATE club_cp_access_mail SET state='accepted',
      accepted_at=now(),password_ciphertext=NULL,claim_token=NULL,claimed_at=NULL,
      provider=$3,provider_message_id=$4,delivery_status=$5,last_sent_at=now(),
      last_error_code=NULL,consecutive_failures=0,status_checked_at=NULL,next_status_check_at=now()+interval '2 minutes',
      status_claim_token=NULL,status_claimed_at=NULL
      WHERE order_id=$1 AND claim_token=$2 RETURNING order_id`,
    [mail.order_id,token,meta.provider,meta.messageId,meta.status]);
    if(updated.rowCount)await client.query(`INSERT INTO club_cp_mail_history
      (id,order_id,provider,provider_message_id,recipient_email,status)
      VALUES($1,$2,$3,$4,$5,$6)`,
    [crypto.randomUUID(),mail.order_id,meta.provider,meta.messageId,meta.recipient,meta.status]);
    await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally {client.release();}
}

export async function recordMailFailure(pool,mail,token,error) {
  const code=safeMailError(error);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const changed=await client.query(`UPDATE club_cp_access_mail SET
      state=CASE WHEN $3::boolean OR consecutive_failures>=7 THEN 'blocked' ELSE 'pending' END,
      consecutive_failures=consecutive_failures+1,last_error_code=$4,
      delivery_status=CASE WHEN $4='send_uncertain' THEN 'unknown' ELSE delivery_status END,
      next_attempt_at=now()+make_interval(secs=>GREATEST($5::integer,LEAST(3600,30*POWER(2,LEAST(consecutive_failures+1,7)))::integer)),
      claim_token=NULL,claimed_at=NULL WHERE order_id=$1 AND claim_token=$2 RETURNING order_id`,
    [mail.order_id,token,error?.status===409||error?.permanent===true||error?.uncertain===true,code,
      Math.max(0,Math.min(86400,Number.parseInt(error?.retryAfterSeconds,10)||0))]);
    if(changed.rowCount)await client.query(`INSERT INTO club_cp_mail_history(id,order_id,status,error_code)
      VALUES($1,$2,'send_failed',$3)`,[crypto.randomUUID(),mail.order_id,code]);
    await client.query('COMMIT');
  }catch(failure){await client.query('ROLLBACK').catch(()=>{});throw failure;}
  finally{client.release();}
}

export async function readNotisendStatus(messageId,{fetcher=fetch,token=process.env.NOTISEND_API_KEY}={}) {
  if(!token||!/^[A-Za-z0-9_-]{1,100}$/.test(String(messageId)))throw new Error('STATUS_NOT_CONFIGURED');
  const response=await fetcher('https://api.notisend.ru/v1/email/messages/'+encodeURIComponent(messageId),{
    headers:{Authorization:'Bearer '+token,Accept:'application/json'},signal:AbortSignal.timeout(10000)
  });
  if(!response.ok)throw new Error('STATUS_UNAVAILABLE');
  const body=await response.json();
  if(String(body?.id)!==String(messageId)||!MAIL_STATUSES.includes(body?.status))throw new Error('STATUS_INVALID');
  // Deliberately discard text/html/events and provider diagnostics.
  return body.status;
}

async function applyStatus(pool,row,token,reader) {
  try {
    const status=await reader(row.provider_message_id);
    if(!MAIL_STATUSES.includes(status))throw new Error('STATUS_INVALID');
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const changed=await client.query(`UPDATE club_cp_access_mail SET delivery_status=$4,
        status_checked_at=now(),last_error_code=NULL,status_claim_token=NULL,status_claimed_at=NULL,
        next_status_check_at=now()+interval '10 minutes'
        WHERE order_id=$1 AND provider_message_id=$2 AND status_claim_token=$3 RETURNING order_id`,
      [row.order_id,row.provider_message_id,token,status]);
      if(changed.rowCount)await client.query(`UPDATE club_cp_mail_history SET status=$3,checked_at=now(),error_code=NULL
        WHERE order_id=$1 AND provider_message_id=$2`,[row.order_id,row.provider_message_id,status]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
    finally{client.release();}
    return true;
  }catch{
    await pool.query(`UPDATE club_cp_access_mail SET last_error_code='status_unavailable',
      next_status_check_at=now()+interval '1 hour',status_claim_token=NULL,status_claimed_at=NULL
      WHERE order_id=$1 AND provider_message_id=$2 AND status_claim_token=$3`,
    [row.order_id,row.provider_message_id,token]);
    return false;
  }
}

// Polling avoids an unauthenticated public mail-status webhook. Every request goes
// to the fixed official API. Small leased batches share work across app instances.
export async function pollMailStatuses(pool,{reader=readNotisendStatus,orderId=null,delay=1000}={}) {
  const token=crypto.randomUUID();
  const batch=await pool.query(`WITH due AS (
    SELECT order_id FROM club_cp_access_mail
    WHERE state='accepted' AND provider='notisend' AND provider_message_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM club_cp_orders o WHERE o.order_id=club_cp_access_mail.order_id AND NOT o.test_mode)
      AND delivery_status IN ('queued','sent','unknown')
      AND (next_status_check_at IS NULL OR next_status_check_at<=now())
      AND (status_claimed_at IS NULL OR status_claimed_at<now()-interval '2 minutes')
      AND ($1::text IS NULL OR order_id=$1)
    ORDER BY next_status_check_at NULLS FIRST LIMIT 5 FOR UPDATE SKIP LOCKED)
    UPDATE club_cp_access_mail m SET status_claim_token=$2,status_claimed_at=now(),
      next_status_check_at=now()+interval '10 minutes'
    FROM due WHERE m.order_id=due.order_id RETURNING m.*`,[orderId,token]);
  let refreshed=0;
  for(const row of batch.rows){
    if(await applyStatus(pool,row,token,reader))refreshed++;
    if(delay&&batch.rows.length>1)await pause(delay);
  }
  return {claimed:batch.rowCount,refreshed};
}

export const ATTENTION_SQL = `(o.status='review' OR
  ${PAYMENT_REVIEW_SQL} OR
  to_jsonb(o)->>'last_payment_status' IN ('failed','canceled','refund_reported','refunded','partially_refunded','refund_failed','unknown','duplicate') OR
  (o.status='paid' AND to_jsonb(o)->>'access_confirmed_at' IS NULL AND (m.order_id IS NULL OR m.state='blocked' OR
    m.delivery_status IN ('skipped','soft_bounced','hard_bounced','unknown') OR
    (m.state IN ('pending','sending') AND o.paid_at<now()-interval '10 minutes') OR
    (m.state='accepted' AND (m.provider_message_id IS NULL OR m.provider<>'notisend'
      OR (m.delivery_status='queued' AND m.last_sent_at<now()-interval '30 minutes')
      OR (m.delivery_status='sent' AND m.last_sent_at<now()-interval '2 hours')
      OR (m.last_error_code='status_unavailable' AND
        COALESCE(m.status_checked_at,m.last_sent_at)<now()-interval '1 hour'))))))`;

export async function notifyMailAttention(pool,send) {
  const count=Number((await pool.query(`SELECT count(*)::integer AS n FROM club_cp_orders o
    LEFT JOIN club_cp_access_mail m USING(order_id) WHERE NOT o.test_mode AND ${ATTENTION_SQL}`)).rows[0].n);
  const token=crypto.randomUUID();
  const claim=await pool.query(`UPDATE club_mail_alert_state SET claim_token=$1,claimed_at=now()
    WHERE id=1 AND (claimed_at IS NULL OR claimed_at<now()-interval '2 minutes')
      AND (retry_at IS NULL OR retry_at<=now())
      AND (($2::integer>0 AND (NOT active OR last_sent_at<now()-interval '6 hours'))
        OR ($2=0 AND active)) RETURNING id`,[token,count]);
  if(!claim.rowCount)return false;
  try{
    const receipt=await send({count,recovery:count===0});
    if(!receipt?.messageId||!['queued','sent','delivered'].includes(receipt.status))throw new Error('ALERT_NOT_ACCEPTED');
    await pool.query(`UPDATE club_mail_alert_state SET active=$2,last_sent_at=now(),
      claim_token=NULL,claimed_at=NULL,retry_at=NULL WHERE id=1 AND claim_token=$1`,[token,count>0]);
    return true;
  }catch{
    // Keep it visible in the panel; avoid a tight-loop email storm if API is down.
    await pool.query(`UPDATE club_mail_alert_state SET retry_at=now()+interval '1 hour',
      claim_token=NULL,claimed_at=NULL WHERE id=1 AND claim_token=$1`,[token]);
    return false;
  }
}

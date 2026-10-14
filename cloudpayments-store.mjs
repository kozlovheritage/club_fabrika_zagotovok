import crypto from 'node:crypto';
import {CloudPaymentsError, cents} from './cloudpayments.mjs';
import {recordMailAccepted,recordMailFailure,PAYMENT_REVIEW_SQL} from './mail-monitor.mjs';

const eventKey = (provider, orderId) => crypto.createHash('sha256').update(provider + ':' + orderId).digest('hex');
export const CLOUD_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS club_cp_orders (
    order_id TEXT PRIMARY KEY, buyer_email TEXT NOT NULL, buyer_name TEXT,
    tariff TEXT NOT NULL CHECK (tariff IN ('basic','premium')),
    amount_cents BIGINT NOT NULL CHECK (amount_cents>0), test_mode BOOLEAN NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','review')),
    payment_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), paid_at TIMESTAMPTZ,
    payment_provider TEXT NOT NULL DEFAULT 'cloudpayments')`,
  `ALTER TABLE club_cp_orders
    ADD COLUMN IF NOT EXISTS last_payment_status TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS receipt_provider TEXT,
    ADD COLUMN IF NOT EXISTS receipt_status TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS receipt_id TEXT`,
  `UPDATE club_cp_orders SET last_payment_status='paid'
    WHERE last_payment_status='pending' AND paid_at IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS club_cp_payments (
    transaction_id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES club_cp_orders(order_id),
    outcome TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS club_cp_payment_events (
    event_id TEXT PRIMARY KEY,order_id TEXT NOT NULL REFERENCES club_cp_orders(order_id),
    payment_provider TEXT NOT NULL CHECK(payment_provider IN ('prodamus','cloudpayments')),
    event_type TEXT NOT NULL,provider_status TEXT NOT NULL,transaction_id TEXT,original_transaction_id TEXT,
    amount_cents BIGINT,currency TEXT,error_code TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS club_cp_payment_events_order
    ON club_cp_payment_events(order_id,created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS club_cp_access_mail (
    order_id TEXT PRIMARY KEY REFERENCES club_cp_orders(order_id),
    user_key TEXT, password_ciphertext TEXT,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','accepted','blocked')),
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    claim_token TEXT, claimed_at TIMESTAMPTZ, accepted_at TIMESTAMPTZ)`
];

const eventDigest=(provider,type,transactionId,status,amountCents,eventTime='')=>
  crypto.createHash('sha256').update([provider,type,transactionId||'',status,amountCents??'',eventTime].join(':')).digest('hex');

export function createCloudStore(pool, {test, grantPremium,receiptProvider=null}) {
  return {
    async saveOrder(checkout, tariff) {
      await pool.query(`INSERT INTO club_cp_orders
        (order_id,buyer_email,buyer_name,tariff,amount_cents,test_mode,receipt_provider)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (order_id) DO NOTHING`,
      [checkout.order_id,checkout.customer_email,checkout.customer_name||null,tariff,cents(checkout.products[0].price),test,receiptProvider]);
    },
    async getOrder(orderId) {
      const result = await pool.query("SELECT * FROM club_cp_orders WHERE order_id=$1 AND payment_provider='cloudpayments'",[orderId]);
      return result.rows[0] || null;
    },
    async saveUrl(orderId, url) {
      await pool.query('UPDATE club_cp_orders SET payment_url=$2 WHERE order_id=$1',[orderId,url]);
    },
    async recordProviderEvent({orderId,provider,type,status,transactionId=null,originalTransactionId=null,amountCents=null,currency='RUB',errorCode=null,eventTime=''}) {
      if(!['prodamus','cloudpayments'].includes(provider)||
        !['fail','cancel','refund','refund_failed','authorized','unknown'].includes(type)||
        !/^[A-Za-z0-9_-]{1,100}$/.test(String(orderId))||
        (transactionId!==null&&!/^[A-Za-z0-9_-]{1,100}$/.test(String(transactionId)))||
        (originalTransactionId!==null&&!/^[A-Za-z0-9_-]{1,100}$/.test(String(originalTransactionId)))||
        (amountCents!==null&&(!Number.isSafeInteger(Number(amountCents))||Number(amountCents)<1))||
        !['RUB'].includes(currency))throw new CloudPaymentsError('Платёжное событие не прошло проверку',422);
      const eventId=eventDigest(provider,type,transactionId,status,amountCents,orderId);
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        const order=(await client.query('SELECT * FROM club_cp_orders WHERE order_id=$1 FOR UPDATE',[orderId])).rows[0];
        if(!order||order.test_mode!==(provider==='cloudpayments'?test:false)||order.payment_provider!==provider)
          throw new CloudPaymentsError('Событие относится к другому заказу',422);
        if(originalTransactionId){
          const original=(await client.query('SELECT order_id FROM club_cp_payments WHERE transaction_id=$1',[originalTransactionId])).rows[0];
          if(original&&original.order_id!==orderId)throw new CloudPaymentsError('Исходный платёж относится к другому заказу',422);
        }
        const added=await client.query(`INSERT INTO club_cp_payment_events
          (event_id,order_id,payment_provider,event_type,provider_status,transaction_id,amount_cents,currency,error_code,original_transaction_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,
        [eventId,orderId,provider,type,String(status||'unknown').slice(0,40),transactionId,
          amountCents===null?null:Number(amountCents),currency,
          /^[a-z0-9_-]{1,60}$/i.test(String(errorCode||''))?String(errorCode):null,originalTransactionId]);
        if(added.rowCount){
          let nextStatus=type==='fail'?'failed':type==='cancel'?'canceled':
            type==='refund'?'refund_reported':type==='authorized'?'authorized':type==='refund_failed'?'refund_failed':'unknown';
          if(['refund_reported','refunded','partially_refunded','canceled','refund_failed'].includes(order.last_payment_status)&&
            !['refund','cancel'].includes(type))nextStatus=order.last_payment_status;
          else if(order.last_payment_status==='paid'&&['fail','authorized'].includes(type))nextStatus='paid';
          await client.query('UPDATE club_cp_orders SET last_payment_status=$2 WHERE order_id=$1',[orderId,nextStatus]);
          if(type==='refund'||type==='cancel')await client.query(`UPDATE club_cp_access_mail
            SET state='blocked',last_error_code='payment_refund_review'
            WHERE order_id=$1 AND state='pending'`,[orderId]);
        }
        await client.query('COMMIT');
        return {recorded:Boolean(added.rowCount)};
      }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
      finally{client.release();}
    },
    async fulfill(orderId, transactionId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const found = await client.query('SELECT * FROM club_cp_orders WHERE order_id=$1 FOR UPDATE',[orderId]);
        const order = found.rows[0];
        if (!order) throw new CloudPaymentsError('Заказ не найден', 422);
        if(order.payment_provider&&order.payment_provider!=='cloudpayments')
          throw new CloudPaymentsError('Заказ относится к другому провайдеру',422);
        // Same buyer lock as the legacy handler; never rotate an existing account.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[order.buyer_email]);
        const previous = await client.query('SELECT order_id FROM club_cp_payments WHERE transaction_id=$1',[transactionId]);
        if (previous.rowCount) {
          if (previous.rows[0].order_id !== orderId) throw new CloudPaymentsError('Транзакция относится к другому заказу',422);
          await client.query('COMMIT'); return;
        }
        const legacy = await client.query('SELECT 1 FROM club_webhook_events WHERE event_id=$1',[eventKey('prodamus',orderId)]);
        let outcome = order.status === 'pending' && !legacy.rowCount ? 'fulfilled' : 'duplicate';
        // Test transactions must NEVER grant accounts or send real access emails,
        // even if a preview accidentally points at the shared production database.
        if (outcome==='fulfilled' && order.test_mode) outcome='test';
        let grant = {};
        const reversed=await client.query(`SELECT ${PAYMENT_REVIEW_SQL} AS required
          FROM club_cp_orders o WHERE o.order_id=$1`,[orderId]);
        if(reversed.rows[0]?.required)outcome='review';
        if (outcome === 'fulfilled' && order.tariff === 'premium') {
          grant = await grantPremium(client, order);
          if (grant.review) outcome = 'review';
        }
        await client.query('INSERT INTO club_cp_payments (transaction_id,order_id,outcome) VALUES ($1,$2,$3)',
          [transactionId,orderId,outcome]);
        await client.query(`INSERT INTO club_cp_payment_events
          (event_id,order_id,payment_provider,event_type,provider_status,transaction_id,amount_cents,currency)
          VALUES($1,$2,'cloudpayments','pay',$3,$4,$5,'RUB') ON CONFLICT(event_id) DO NOTHING`,
        [eventDigest('cloudpayments','pay',transactionId,'completed',order.amount_cents),
          orderId,outcome==='fulfilled'||outcome==='review'?'completed':outcome,transactionId,order.amount_cents]);
        if (outcome === 'fulfilled') {
          await client.query(`INSERT INTO club_webhook_events (event_id,payload) VALUES ($1,$2::jsonb)
            ON CONFLICT (event_id) DO NOTHING`,[eventKey('cloudpayments',orderId),JSON.stringify({
            source:'site',tariff:order.tariff,handledBy:'cloudpayments',transactionId,testMode:order.test_mode
          })]);
          await client.query(`INSERT INTO club_cp_access_mail (order_id,user_key,password_ciphertext)
            VALUES ($1,$2,$3) ON CONFLICT (order_id) DO NOTHING`,
          [orderId,grant.userKey||null,grant.ciphertext||null]);
        }
        await client.query(`UPDATE club_cp_orders SET status=$2,paid_at=COALESCE(paid_at,now())
          WHERE order_id=$1`,[orderId,outcome==='review'||order.status==='review'?'review':'paid']);
        await client.query(`UPDATE club_cp_orders SET last_payment_status=CASE
          WHEN last_payment_status IN ('refund_reported','refunded','partially_refunded','canceled','refund_failed') THEN last_payment_status ELSE $2 END WHERE order_id=$1`,
          [orderId,outcome==='duplicate'?'duplicate':'paid']);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(()=>{}); throw error;
      } finally { client.release(); }
    }
  };
}

// Durable, leased, at-least-once delivery. No passwords in logs or plaintext DB fields.
// Accepted by mail API != delivered into the customer's inbox.
export async function drainAccessMail(pool, send, batchSize = 10,providers=['cloudpayments']) {
  // A crash/timeout after dispatch may mean the provider accepted the email.
  // Never automatically redispatch an expired lease with an unknown outcome.
  await pool.query(`WITH expired AS (
    UPDATE club_cp_access_mail m SET state='blocked',last_error_code='send_uncertain',
      delivery_status='unknown',claim_token=NULL,claimed_at=NULL
    WHERE state='sending' AND claimed_at<now()-interval '10 minutes'
      AND EXISTS(SELECT 1 FROM club_cp_orders o WHERE o.order_id=m.order_id AND o.payment_provider=ANY($1::text[]))
    RETURNING order_id)
    INSERT INTO club_cp_mail_history(id,order_id,status,error_code)
    SELECT gen_random_uuid(),order_id,'send_failed','send_uncertain' FROM expired`,[providers]);
  const token = crypto.randomUUID();
  const batch = await pool.query(`WITH due AS (
    SELECT order_id FROM club_cp_access_mail
    WHERE state='pending' AND next_attempt_at<=now()
      AND EXISTS(SELECT 1 FROM club_cp_orders o WHERE o.order_id=club_cp_access_mail.order_id
        AND o.payment_provider=ANY($3::text[]) AND NOT o.test_mode AND o.status='paid'
        AND to_jsonb(o)->>'access_confirmed_at' IS NULL)
    ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
    UPDATE club_cp_access_mail m SET state='sending',claim_token=$2,claimed_at=now(),attempts=m.attempts+1
    FROM due WHERE m.order_id=due.order_id
    RETURNING m.*`,[batchSize,token,providers]);
  for (const mail of batch.rows) {
    let accepted=false;
    try {
      const order = await pool.query('SELECT * FROM club_cp_orders WHERE order_id=$1',[mail.order_id]);
      if (!order.rows[0] || order.rows[0].test_mode || order.rows[0].status!=='paid') throw new CloudPaymentsError('Отправка требует проверки',409);
      const receipt=await send(order.rows[0],mail);
      accepted=true;
      await recordMailAccepted(pool,mail,token,receipt);
    } catch (error) {
      if(accepted)error.uncertain=true;
      await recordMailFailure(pool,mail,token,error);
    }
  }
}

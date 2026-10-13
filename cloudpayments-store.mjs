import crypto from 'node:crypto';
import {CloudPaymentsError, cents} from './cloudpayments.mjs';
import {recordMailAccepted,recordMailFailure} from './mail-monitor.mjs';

const eventKey = (provider, orderId) => crypto.createHash('sha256').update(provider + ':' + orderId).digest('hex');
export const CLOUD_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS club_cp_orders (
    order_id TEXT PRIMARY KEY, buyer_email TEXT NOT NULL, buyer_name TEXT,
    tariff TEXT NOT NULL CHECK (tariff IN ('basic','premium')),
    amount_cents BIGINT NOT NULL CHECK (amount_cents>0), test_mode BOOLEAN NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','review')),
    payment_url TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), paid_at TIMESTAMPTZ)`,
  `CREATE TABLE IF NOT EXISTS club_cp_payments (
    transaction_id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES club_cp_orders(order_id),
    outcome TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS club_cp_access_mail (
    order_id TEXT PRIMARY KEY REFERENCES club_cp_orders(order_id),
    user_key TEXT, password_ciphertext TEXT,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','sending','accepted','blocked')),
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    claim_token TEXT, claimed_at TIMESTAMPTZ, accepted_at TIMESTAMPTZ)`
];

export function createCloudStore(pool, {test, grantPremium}) {
  return {
    async saveOrder(checkout, tariff) {
      await pool.query(`INSERT INTO club_cp_orders
        (order_id,buyer_email,buyer_name,tariff,amount_cents,test_mode)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (order_id) DO NOTHING`,
      [checkout.order_id,checkout.customer_email,checkout.customer_name||null,tariff,cents(checkout.products[0].price),test]);
    },
    async getOrder(orderId) {
      const result = await pool.query('SELECT * FROM club_cp_orders WHERE order_id=$1',[orderId]);
      return result.rows[0] || null;
    },
    async saveUrl(orderId, url) {
      await pool.query('UPDATE club_cp_orders SET payment_url=$2 WHERE order_id=$1',[orderId,url]);
    },
    async fulfill(orderId, transactionId) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const found = await client.query('SELECT * FROM club_cp_orders WHERE order_id=$1 FOR UPDATE',[orderId]);
        const order = found.rows[0];
        if (!order) throw new CloudPaymentsError('Заказ не найден', 422);
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
        if (outcome === 'fulfilled' && order.tariff === 'premium') {
          grant = await grantPremium(client, order);
          if (grant.review) outcome = 'review';
        }
        await client.query('INSERT INTO club_cp_payments (transaction_id,order_id,outcome) VALUES ($1,$2,$3)',
          [transactionId,orderId,outcome]);
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
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(()=>{}); throw error;
      } finally { client.release(); }
    }
  };
}

// Durable, leased, at-least-once delivery. No passwords in logs or plaintext DB fields.
// Accepted by mail API != delivered into the customer's inbox.
export async function drainAccessMail(pool, send, batchSize = 10) {
  const token = crypto.randomUUID();
  const batch = await pool.query(`WITH due AS (
    SELECT order_id FROM club_cp_access_mail
    WHERE (state='pending' AND next_attempt_at<=now())
      OR (state='sending' AND claimed_at<now()-interval '2 minutes')
    ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
    UPDATE club_cp_access_mail m SET state='sending',claim_token=$2,claimed_at=now(),attempts=m.attempts+1
    FROM due WHERE m.order_id=due.order_id
    RETURNING m.*`,[batchSize,token]);
  for (const mail of batch.rows) {
    try {
      const order = await pool.query('SELECT * FROM club_cp_orders WHERE order_id=$1',[mail.order_id]);
      if (!order.rows[0] || order.rows[0].test_mode || order.rows[0].status!=='paid') throw new CloudPaymentsError('Отправка требует проверки',409);
      const receipt=await send(order.rows[0],mail);
      await recordMailAccepted(pool,mail,token,receipt);
    } catch (error) {
      await recordMailFailure(pool,mail,token,error);
    }
  }
}

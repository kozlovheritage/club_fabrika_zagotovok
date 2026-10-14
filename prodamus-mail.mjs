import crypto from 'node:crypto';
import {cents,CloudPaymentsError} from './cloudpayments.mjs';
import {PAYMENT_REVIEW_SQL} from './mail-monitor.mjs';

// An immutable order marker, not the current switch, decides who sends access.
// Existing/unmarked orders remain with Prodamus; enabling does not resend history.
export const PRODAMUS_MAIL_SCHEMA=[
  `ALTER TABLE club_cp_orders ADD COLUMN IF NOT EXISTS payment_provider TEXT NOT NULL DEFAULT 'cloudpayments'`,
  `CREATE INDEX IF NOT EXISTS club_access_orders_provider ON club_cp_orders(payment_provider,status)`
];
export const PLATFORM_ACCESS_NOTICE='После подтверждения оплаты письмо с доступом отправит служба заботы клуба «Фабрика заготовок». Если письма нет, обратитесь в службу заботы. Это уведомление не содержит данных для входа.';

export function prodamusDeliveryMode(env=process.env){
  const mode=env.PRODAMUS_ACCESS_DELIVERY||'prodamus';
  if(!['prodamus','platform'].includes(mode))throw new Error('Invalid PRODAMUS_ACCESS_DELIVERY');
  if(env.PRODAMUS_ACCESS_WORKER_ENABLED!==undefined&&!['true','false'].includes(env.PRODAMUS_ACCESS_WORKER_ENABLED))
    throw new Error('Invalid PRODAMUS_ACCESS_WORKER_ENABLED');
  if(mode==='platform'&&env.PRODAMUS_ACCESS_WORKER_ENABLED!=='true')
    throw new Error('Platform access delivery requires an explicitly enabled worker');
  if(mode==='platform'&&(env.AUTH_EMAIL_PROVIDER!=='notisend'||!env.NOTISEND_API_KEY||
    !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(env.AUTH_FROM_EMAIL||'')))
    throw new Error('Platform access delivery requires a configured NotiSend sender');
  return mode;
}
export async function saveProdamusMailOrder(client,checkout,tariff){
  await client.query(`INSERT INTO club_cp_orders
    (order_id,buyer_email,buyer_name,tariff,amount_cents,test_mode,payment_provider)
    VALUES($1,$2,$3,$4,$5,false,'prodamus')`,
  [checkout.order_id,checkout.customer_email,checkout.customer_name||null,tariff,cents(checkout.products[0].price)]);
}
export async function getProdamusMailOrder(pool,orderId){
  return (await pool.query("SELECT * FROM club_cp_orders WHERE order_id=$1 AND payment_provider='prodamus'",[orderId])).rows[0]||null;
}
const eventKey=(provider,id)=>crypto.createHash('sha256').update(provider+':'+id).digest('hex');

// Called only after the HTTP handler validates the genuine provider signature,
// successful payment status and signed checkout/product/price.
export async function fulfillProdamusMailOrder(pool,orderId,payload,{grantPremium}){
  const providerId=String(payload.order_id||'');
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(providerId))throw new CloudPaymentsError('Неизвестный номер платежа',422);
  const transactionId='prodamus:'+providerId;
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const order=(await client.query("SELECT * FROM club_cp_orders WHERE order_id=$1 AND payment_provider='prodamus' FOR UPDATE",[orderId])).rows[0];
    if(!order||order.test_mode||order.buyer_email!==String(payload.customer_email||'').trim().toLowerCase()||
      order.amount_cents!==String(cents(payload.sum)))
      throw new CloudPaymentsError('Подтверждение не соответствует сохранённому заказу',422);
    // Reversal writers take this same order lock. Read the ledger after acquiring
    // it, rather than trusting a mutable status projection or a transaction ID.
    const requiresReview=(await client.query(`SELECT ${PAYMENT_REVIEW_SQL} AS required
      FROM club_cp_orders o WHERE o.order_id=$1`,[orderId])).rows[0]?.required;
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[order.buyer_email]);
    const previous=(await client.query('SELECT order_id FROM club_cp_payments WHERE transaction_id=$1',[transactionId])).rows[0];
    if(previous){
      if(previous.order_id!==orderId)throw new CloudPaymentsError('Платёж относится к другому заказу',422);
      if(requiresReview)await client.query("UPDATE club_cp_orders SET status='review' WHERE order_id=$1",[orderId]);
      await client.query('COMMIT');return;
    }
    const already=await client.query('SELECT 1 FROM club_webhook_events WHERE event_id IN ($1,$2)',
      [eventKey('prodamus',orderId),eventKey('cloudpayments',orderId)]);
    let outcome=requiresReview?'review':order.status==='pending'&&!already.rowCount?'fulfilled':'duplicate';
    let grant={};
    if(outcome==='fulfilled'&&order.tariff==='premium'){
      grant=await grantPremium(client,order);
      if(grant.review)outcome='review';
    }
    await client.query('INSERT INTO club_cp_payments(transaction_id,order_id,outcome) VALUES($1,$2,$3)',[transactionId,orderId,outcome]);
    await client.query(`INSERT INTO club_cp_payment_events
      (event_id,order_id,payment_provider,event_type,provider_status,transaction_id,amount_cents,currency)
      VALUES($1,$2,'prodamus','pay',$3,$4,$5,'RUB') ON CONFLICT(event_id) DO NOTHING`,
    [eventKey('prodamus-payment',providerId),orderId,outcome==='duplicate'?'duplicate':'completed',providerId,order.amount_cents]);
    if(outcome==='fulfilled'){
      await client.query(`INSERT INTO club_webhook_events(event_id,payload) VALUES($1,$2::jsonb)`,
        [eventKey('prodamus',orderId),JSON.stringify({source:'site',tariff:order.tariff,
          orderNum:orderId,providerOrderId:providerId,handledBy:'platform',paymentProvider:'prodamus'})]);
      await client.query(`INSERT INTO club_cp_access_mail(order_id,user_key,password_ciphertext)
        VALUES($1,$2,$3)`,[orderId,grant.userKey||null,grant.ciphertext||null]);
    }
    await client.query(`UPDATE club_cp_orders SET status=$2,last_payment_status=CASE
      WHEN last_payment_status IN ('refund_reported','refunded','partially_refunded','canceled','refund_failed')
      THEN last_payment_status ELSE $3 END,paid_at=COALESCE(paid_at,now()) WHERE order_id=$1`,
      [orderId,outcome==='review'||order.status==='review'||(outcome==='duplicate'&&order.status==='pending')?'review':'paid',
        outcome==='duplicate'?'duplicate':'paid']);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
}

import crypto from 'node:crypto';
import {ATTENTION_SQL,PAYMENT_REVIEW_SQL} from './mail-monitor.mjs';

export class SupportError extends Error {
  constructor(message,status=409){super(message);this.status=status;}
}
export const ADMIN_SCHEMA=[
  `CREATE TABLE IF NOT EXISTS club_admin_accounts (
    user_key TEXT PRIMARY KEY REFERENCES club_users(email) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT true,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS club_admin_audit (
    id BIGSERIAL PRIMARY KEY, actor_key TEXT NOT NULL,order_id TEXT,
    action TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS club_admin_audit_order ON club_admin_audit(order_id,created_at DESC)`
];
export const CHECKOUT_PROVIDER_SCHEMA=[
  `CREATE TABLE IF NOT EXISTS club_checkout_provider_state (
    id INTEGER PRIMARY KEY CHECK(id=1),active_provider TEXT NOT NULL
      CHECK(active_provider IN ('prodamus','cloudpayments')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS club_checkout_provider_history (
    id BIGSERIAL PRIMARY KEY,previous_provider TEXT NOT NULL,
    next_provider TEXT NOT NULL,changed_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE INDEX IF NOT EXISTS club_checkout_provider_history_time
    ON club_checkout_provider_history(changed_at DESC)`
];
const orderColumns=`o.order_id,o.buyer_email,COALESCE(u.login_email,o.buyer_email) AS recipient_email,
  o.buyer_name,o.tariff,o.amount_cents,o.status,o.paid_at,o.created_at,
  to_jsonb(o)->>'last_payment_status' AS last_payment_status,
  ${PAYMENT_REVIEW_SQL} AS payment_requires_review,
  to_jsonb(o)->>'payment_provider' AS payment_provider,
  to_jsonb(o)->>'receipt_provider' AS receipt_provider,
  to_jsonb(o)->>'receipt_status' AS receipt_status,
  to_jsonb(o)->>'receipt_id' AS receipt_id,
  m.state AS mail_state,m.delivery_status,m.provider,m.provider_message_id,
  COALESCE(m.attempts,0) AS attempts,m.last_error_code,m.status_checked_at,m.last_sent_at,
  ${ATTENTION_SQL} AS needs_attention`;

export function createAdminStore(pool,{resolveCredential}={}){
  return {
    async initializeCheckoutProvider(provider){
      if(!['prodamus','cloudpayments'].includes(provider))throw new SupportError('Неизвестный платёжный сервис',400);
      await pool.query(`INSERT INTO club_checkout_provider_state(id,active_provider)
        VALUES(1,$1) ON CONFLICT(id) DO NOTHING`,[provider]);
    },
    async activeCheckoutProvider(){
      const row=(await pool.query('SELECT active_provider FROM club_checkout_provider_state WHERE id=1')).rows[0];
      if(!row)throw new SupportError('Способ оплаты ещё не настроен',503);
      return row.active_provider;
    },
    async setCheckoutProvider(provider,expectedProvider){
      if(!['prodamus','cloudpayments'].includes(provider)||!['prodamus','cloudpayments'].includes(expectedProvider))
        throw new SupportError('Укажите текущий и новый платёжный сервис',400);
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        const current=(await client.query('SELECT active_provider FROM club_checkout_provider_state WHERE id=1 FOR UPDATE')).rows[0];
        if(!current||current.active_provider!==expectedProvider)
          throw new SupportError('Способ оплаты уже изменился. Сначала проверьте текущий');
        if(current.active_provider!==provider){
          await client.query('UPDATE club_checkout_provider_state SET active_provider=$1,updated_at=now() WHERE id=1',[provider]);
          await client.query('INSERT INTO club_checkout_provider_history(previous_provider,next_provider) VALUES($1,$2)',
            [current.active_provider,provider]);
        }
        await client.query('COMMIT');
        return {previous:current.active_provider,active:provider,changed:current.active_provider!==provider};
      }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
      finally{client.release();}
    },
    async checkoutProviderHistory(){
      return (await pool.query(`SELECT previous_provider,next_provider,changed_at
        FROM club_checkout_provider_history ORDER BY changed_at DESC LIMIT 20`)).rows;
    },
    async isAdmin(userKey){
      if(!userKey)return false;
      return (await pool.query('SELECT 1 FROM club_admin_accounts WHERE user_key=$1 AND enabled',[userKey])).rowCount===1;
    },
    async list({filter='attention',q='',page=1}={}){
      page=Math.max(1,Math.min(10000,Number.parseInt(page,10)||1));
      // Escape LIKE metacharacters: this is a literal search, not a user SQL pattern.
      const term=String(q).trim().slice(0,120).replace(/[\\%_]/g,'\\$&');
      const predicate=`NOT o.test_mode AND o.status IN ('pending','paid','review')
        AND ($1::text='' OR o.buyer_email ILIKE '%'||$1||'%'
          OR u.login_email ILIKE '%'||$1||'%'
          OR o.buyer_name ILIKE '%'||$1||'%' OR o.order_id ILIKE '%'||$1||'%')
        AND ($2::text='all' OR ${ATTENTION_SQL})`;
      const args=[term,filter==='all'?'all':'attention'];
      const total=Number((await pool.query(`SELECT count(*)::integer AS n FROM club_cp_orders o
        LEFT JOIN club_cp_access_mail m USING(order_id)
        LEFT JOIN club_users u ON u.email=m.user_key WHERE ${predicate}`,args)).rows[0].n);
      const orders=(await pool.query(`SELECT ${orderColumns} FROM club_cp_orders o
        LEFT JOIN club_cp_access_mail m USING(order_id)
        LEFT JOIN club_users u ON u.email=m.user_key WHERE ${predicate}
        ORDER BY o.paid_at DESC NULLS LAST,o.order_id DESC LIMIT 25 OFFSET $3`,
      [...args,(page-1)*25])).rows;
      const s=(await pool.query(`SELECT
        count(*) FILTER(WHERE ${ATTENTION_SQL})::integer AS attention,
        count(*) FILTER(WHERE m.delivery_status='delivered')::integer AS delivered,
        count(*) FILTER(WHERE NOT ${ATTENTION_SQL} AND COALESCE(m.delivery_status,'')<>'delivered')::integer AS "inProgress"
        FROM club_cp_orders o LEFT JOIN club_cp_access_mail m USING(order_id)
        WHERE NOT o.test_mode AND o.status IN ('pending','paid','review')`)).rows[0];
      return {orders,total,page,pageSize:25,summary:s};
    },
    async detail(orderId){
      const found=await pool.query(`SELECT ${orderColumns} FROM club_cp_orders o
        LEFT JOIN club_cp_access_mail m USING(order_id)
        LEFT JOIN club_users u ON u.email=m.user_key WHERE o.order_id=$1 AND NOT o.test_mode`,[orderId]);
      if(!found.rowCount)throw new SupportError('Заказ не найден',404);
      const history=(await pool.query(`SELECT provider,provider_message_id,status,recipient_email,
        sent_at,checked_at,error_code FROM club_cp_mail_history WHERE order_id=$1 ORDER BY sent_at DESC LIMIT 100`,[orderId])).rows;
      const paymentHistory=(await pool.query(`SELECT payment_provider,event_type,provider_status,
        transaction_id,original_transaction_id,amount_cents,currency,error_code,created_at
        FROM club_cp_payment_events WHERE order_id=$1 ORDER BY created_at DESC LIMIT 100`,[orderId])).rows;
      const audit=(await pool.query(`SELECT action,created_at FROM club_admin_audit WHERE order_id=$1
        ORDER BY created_at DESC LIMIT 100`,[orderId])).rows;
      return {order:found.rows[0],history,paymentHistory,audit};
    },
    async resend(orderId,actor,body){
      if(!['customer_request','delivery_failed'].includes(body?.reason)||
        !Number.isSafeInteger(body?.expectedAttempts)||
        !(body?.expectedMessageId===null||typeof body?.expectedMessageId==='string'))
        throw new SupportError('Подтвердите причину и обновите данные заказа',400);
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        // Serializes sends by an admin and rechecks revocation inside the transaction.
        const admin=await client.query('SELECT 1 FROM club_admin_accounts WHERE user_key=$1 AND enabled FOR UPDATE',[actor]);
        if(!admin.rowCount)throw new SupportError('Нет прав администратора',403);
        const recent=await client.query(`SELECT count(*)::integer AS n FROM club_admin_audit
          WHERE actor_key=$1 AND action LIKE 'resend:%' AND created_at>now()-interval '1 hour'`,[actor]);
        if(Number(recent.rows[0].n)>=30)throw new SupportError('Лимит повторных писем: 30 в час',429);
        const order=(await client.query('SELECT * FROM club_cp_orders WHERE order_id=$1 FOR UPDATE',[orderId])).rows[0];
        if(!order||order.test_mode||order.status!=='paid'||
          ['refund_reported','refunded','partially_refunded','canceled','refund_failed'].includes(order.last_payment_status))
          throw new SupportError('Нет подтверждённой рабочей оплаты без возврата');
        // A separate statement after the order lock sees any committed reversal.
        // Its writer takes the same order lock, so it cannot race this authorization.
        const review=(await client.query(`SELECT ${PAYMENT_REVIEW_SQL} AS required
          FROM club_cp_orders o WHERE o.order_id=$1`,[orderId])).rows[0];
        if(review?.required)throw new SupportError('В истории есть возврат или отмена. Требуется проверка оплаты');
        const fulfilled=await client.query(`SELECT 1 FROM club_cp_payments WHERE order_id=$1 AND outcome='fulfilled' LIMIT 1`,[orderId]);
        if(!fulfilled.rowCount)throw new SupportError('Выдача доступа требует проверки');
        const mail=(await client.query(`SELECT *,last_sent_at>now()-interval '10 minutes' AS cooling,
          status_claimed_at>now()-interval '2 minutes' AS checking
          FROM club_cp_access_mail WHERE order_id=$1 FOR UPDATE`,[orderId])).rows[0];
        if(!mail||!['accepted','blocked'].includes(mail.state)||mail.checking)
          throw new SupportError('Письмо уже обрабатывается или требует проверки');
        if(mail.attempts!==body.expectedAttempts||mail.provider_message_id!==body.expectedMessageId)
          throw new SupportError('Заказ изменился. Обновите страницу');
        if(mail.cooling)throw new SupportError('Подождите 10 минут после последней отправки',429);
        if(['delivered','hard_bounced','skipped'].includes(mail.delivery_status)&&body.reason!=='customer_request')
          throw new SupportError('Нужно подтверждение запроса самого клиента');
        if(mail.last_error_code==='send_uncertain'&&body.reason!=='customer_request')
          throw new SupportError('Результат отправки неизвестен. Проверьте письмо у провайдера и запрос клиента');
        const ciphertext=order.tariff==='premium'?await resolveCredential(client,order,mail):null;
        if(order.tariff==='premium'&&!ciphertext)throw new SupportError('Данные входа изменены. Нужна проверка доступа');
        await client.query(`UPDATE club_cp_access_mail SET state='pending',password_ciphertext=$2,
          next_attempt_at=now(),claim_token=NULL,claimed_at=NULL,last_error_code=NULL,
          consecutive_failures=0,status_claim_token=NULL,status_claimed_at=NULL WHERE order_id=$1`,[orderId,ciphertext]);
        await client.query('INSERT INTO club_admin_audit(actor_key,order_id,action) VALUES($1,$2,$3)',
          [actor,orderId,'resend:'+body.reason]);
        await client.query('COMMIT');
        return {ok:true};
      }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
      finally{client.release();}
    },
    async audit(actor,order,action){
      await pool.query('INSERT INTO club_admin_audit(actor_key,order_id,action) VALUES($1,$2,$3)',[actor,order,action]);
    }
  };
}

// Explicit operator-only transaction. Never invoked on startup or ordinary login.
// Ambiguous duplicate email records fail closed; no password, tariff or email writes.
export async function provisionOwner(pool,{email,expectedName,displayName}){
  const normalized=String(email||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)||!expectedName||
    !displayName||String(displayName).length>100)throw new SupportError('Invalid private provisioning configuration',400);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('club-admin-owner-provision'))");
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[normalized]);
    const found=await client.query(`SELECT email,name,login_email,status,tariff,password_hash,
      (access_until IS NULL OR access_until>now()) AS valid FROM club_users
      WHERE email=$1 OR login_email=$1 FOR UPDATE`,[normalized]);
    if(found.rowCount!==1)throw new SupportError('Account missing or ambiguous; no changes made');
    const user=found.rows[0];
    if(user.status!=='active'||user.tariff!=='premium'||!user.password_hash||!user.valid)
      throw new SupportError('Account is not an active platform member');
    const already=await client.query('SELECT 1 FROM club_admin_accounts WHERE user_key=$1 AND enabled',[user.email]);
    if(user.name!==expectedName&&!(already.rowCount&&user.name===displayName))
      throw new SupportError('Previous display name does not match');
    const others=await client.query('SELECT 1 FROM club_admin_accounts WHERE user_key<>$1 AND enabled',[user.email]);
    if(others.rowCount)throw new SupportError('Another admin exists; explicit review required');
    await client.query(`INSERT INTO club_admin_accounts(user_key) VALUES($1)
      ON CONFLICT(user_key) DO UPDATE SET enabled=true`,[user.email]);
    await client.query('UPDATE club_users SET name=$2,updated_at=now() WHERE email=$1',[user.email,displayName]);
    if(!already.rowCount||user.name!==displayName)await client.query(`INSERT INTO club_admin_audit(actor_key,action)
      VALUES($1,'owner:provisioned')`,[user.email]);
    await client.query('COMMIT');
    return {ok:true};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
}

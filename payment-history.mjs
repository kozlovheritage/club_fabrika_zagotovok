import {digest,HistoryInputError} from './history-csv.mjs';
import {SupportError} from './admin-store.mjs';
import {readHistoryCoverage,readAdminAnalytics} from './admin-analytics.mjs';

// A separate ledger: it has NO triggers, account writes, fulfillment or outbox.
export const HISTORY_SCHEMA=[
  `CREATE TABLE IF NOT EXISTS club_payment_history(
    id TEXT PRIMARY KEY,provider TEXT NOT NULL,provider_id TEXT NOT NULL,
    order_id TEXT,buyer_email TEXT,amount_cents BIGINT NOT NULL,currency TEXT NOT NULL,
    tariff TEXT NOT NULL,status TEXT NOT NULL,source_status TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,source TEXT NOT NULL,
    identity_conflict BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),UNIQUE(provider,provider_id))`,
  `CREATE INDEX IF NOT EXISTS club_payment_history_order ON club_payment_history(order_id)`,
  `CREATE INDEX IF NOT EXISTS club_payment_history_date ON club_payment_history(occurred_at DESC,id)`,
  `CREATE TABLE IF NOT EXISTS club_history_events(
    id TEXT PRIMARY KEY,record_key TEXT UNIQUE NOT NULL,kind TEXT NOT NULL,
    provider TEXT NOT NULL,provider_id TEXT NOT NULL,order_id TEXT,buyer_email TEXT,
    amount_cents BIGINT NOT NULL,currency TEXT NOT NULL,tariff TEXT NOT NULL,
    status TEXT NOT NULL,source_status TEXT NOT NULL,occurred_at TIMESTAMPTZ NOT NULL,
    source TEXT NOT NULL,payment_method TEXT,occurrences INTEGER NOT NULL DEFAULT 1)`,
  `CREATE INDEX IF NOT EXISTS club_history_events_order ON club_history_events(order_id,occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS club_history_events_date ON club_history_events(occurred_at DESC,id)`,
  `CREATE TABLE IF NOT EXISTS club_history_sync(
    id INTEGER PRIMARY KEY CHECK(id=1),last_success_at TIMESTAMPTZ,last_error TEXT,
    last_import_at TIMESTAMPTZ,import_counts JSONB)`,
  `INSERT INTO club_history_sync(id) VALUES(1) ON CONFLICT DO NOTHING`
];
const rank={pending:0,failed:1,review:2,paid:3,received:4,settled:5,partially_refunded:6,refunded:7};
export function mergeFinancialStatus(previous,incoming){
  if(!(previous in rank)||!(incoming in rank))throw new HistoryInputError('INVALID_STATUS');
  return rank[incoming]>rank[previous]?incoming:previous;
}
async function saveRecord(client,r){
  if(r.kind==='payment'){
    const found=(await client.query('SELECT * FROM club_payment_history WHERE id=$1 FOR UPDATE',[r.id])).rows[0];
    if(found){
      const conflict=found.provider_id!==r.provider_id||found.provider!==r.provider||
        (found.order_id&&r.order_id&&found.order_id!==r.order_id)||
        (found.buyer_email&&r.buyer_email&&found.buyer_email!==r.buyer_email)||
        Number(found.amount_cents)!==Number(r.amount_cents)||found.currency!==r.currency;
      const status=mergeFinancialStatus(found.status,r.status);
      await client.query(`UPDATE club_payment_history SET status=$2,
        source_status=CASE WHEN status<>$2 THEN $3 ELSE source_status END,
        order_id=COALESCE(order_id,$4),buyer_email=COALESCE(buyer_email,$5),
        identity_conflict=identity_conflict OR $6,updated_at=now()
        WHERE id=$1 AND (status<>$2 OR (order_id IS NULL AND $4::text IS NOT NULL)
          OR (buyer_email IS NULL AND $5::text IS NOT NULL) OR ($6 AND NOT identity_conflict))`,
      [r.id,status,r.source_status,r.order_id,r.buyer_email,conflict]);
    }else await client.query(`INSERT INTO club_payment_history
      (id,provider,provider_id,order_id,buyer_email,amount_cents,currency,tariff,status,source_status,occurred_at,source)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [r.id,r.provider,r.provider_id,r.order_id,r.buyer_email,r.amount_cents,r.currency,r.tariff,
      r.status,r.source_status,r.occurred_at,r.source]);
  }
  // Both source payment observations and checkout activity remain traceable.
  // Exact duplicate export events are represented with occurrences, not sales.
  await client.query(`INSERT INTO club_history_events
    (id,record_key,kind,provider,provider_id,order_id,buyer_email,amount_cents,currency,tariff,
      status,source_status,occurred_at,source,payment_method,occurrences)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT(record_key) DO UPDATE SET occurrences=GREATEST(club_history_events.occurrences,EXCLUDED.occurrences)`,
  [digest(r.record_key),r.record_key,r.kind,r.provider,r.provider_id,r.order_id,r.buyer_email,
    r.amount_cents,r.currency,r.tariff,r.status,r.source_status,r.occurred_at,r.source,r.payment_method||null,r.occurrences||1]);
}
const limitsNote='Новые оплаты и действия поступают из уведомлений платформы; её платёжный журнал сверяется каждую минуту. Полная история в Prodamus не опрашивается. Пропущенное уведомление, старый статус или возврат без уведомления требуют новой выгрузки. Отсутствие письма в истории не означает, что оно не отправлялось.';
const mailJoin=`LEFT JOIN club_cp_orders o ON o.order_id=h.order_id AND NOT o.test_mode
  AND NOT h.identity_conflict AND h.currency='RUB'
  AND o.payment_provider=h.provider AND o.buyer_email=h.buyer_email AND o.amount_cents=h.amount_cents
  LEFT JOIN club_cp_access_mail m ON m.order_id=o.order_id`;
const projection=`h.*,COALESCE(m.delivery_status,'not_verified') AS mail_status`;
export function createPaymentHistory(pool){
  async function transaction(fn,{tryLock=false}={}){
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      const lock=tryLock
        ?(await c.query("SELECT pg_try_advisory_xact_lock(hashtext('club-history-write')) AS ok")).rows[0].ok
        :(await c.query("SELECT pg_advisory_xact_lock(hashtext('club-history-write'))"),true);
      if(!lock){await c.query('ROLLBACK');return {skipped:true};}
      const result=await fn(c);
      await c.query('COMMIT');return result;
    }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}
    finally{c.release();}
  }
  return {
    async analytics({period='30'}={}){return readAdminAnalytics(pool,period);},
    async importExports(payments,leads){
      return transaction(async c=>{
        for(const r of [...payments.records,...leads.records])await saveRecord(c,r);
        const counts={paymentRows:payments.rows,payments:payments.unique,leadRows:leads.rows,
          leads:leads.unique,duplicateLeads:leads.duplicates,statuses:payments.statuses,
          minDate:payments.minDate,maxDate:payments.maxDate};
        await c.query(`UPDATE club_history_sync SET last_import_at=now(),import_counts=$1::jsonb WHERE id=1`,[JSON.stringify(counts)]);
        return counts;
      });
    },
    // Only call after signature AND owned-checkout verification. This ledger
    // cannot issue access. A failed ledger observation never changes checkout.
    async observeProdamus(payload,checkout){
      const id=String(payload.order_id||'');
      const orderId=String(payload.order_num||'');
      const status=String(payload.payment_status||'').toLowerCase();
      if(!/^[A-Za-z0-9_-]{1,100}$/.test(id)||!orderId||!['success','order_canceled','order_denied'].includes(status))
        return;
      const date=new Date(payload.date);
      if(!Number.isFinite(date.getTime()))return;
      const rawAmount=String(payload.sum);
      if(!/^\d{1,10}([.,]\d{1,2})?$/.test(rawAmount))return;
      const amount=Math.round(Number(rawAmount.replace(',','.'))*100);
      if(!Number.isSafeInteger(amount)||amount<0)return;
      const r={id:digest('prodamus:'+id),provider:'prodamus',provider_id:id,order_id:orderId,
        buyer_email:String(payload.customer_email||'').trim().toLowerCase(),amount_cents:amount,
        currency:'RUB',tariff:checkout.tariff,kind:status==='success'?'payment':'lead',
        status:status==='success'?'paid':'lead',source_status:status==='success'?'Оплата подтверждена':
          status==='order_canceled'?'Отмена заказа (уведомление Prodamus)':'Отказ (уведомление Prodamus)',
        occurred_at:date.toISOString(),source:'platform',record_key:`notice:${id}:${status}:${date.toISOString()}`};
      if(payload.currency&&String(payload.currency).toLowerCase()!=='rub')return;
      return transaction(c=>saveRecord(c,r),{tryLock:true});
    },
    async reconcile(){
      try{
        return await transaction(async c=>{
          const payments=(await c.query(`SELECT p.transaction_id,p.created_at,o.order_id,o.buyer_email,
            o.amount_cents,o.tariff,o.paid_at FROM club_cp_payments p JOIN club_cp_orders o USING(order_id)
            WHERE o.payment_provider='prodamus' AND NOT o.test_mode
              AND p.transaction_id LIKE 'prodamus:%' AND p.outcome IN('fulfilled','duplicate','review')
              AND NOT EXISTS(SELECT 1 FROM club_history_events e WHERE e.record_key='platform-payment:'||p.transaction_id)
            ORDER BY p.created_at LIMIT 500`)).rows;
          for(const p of payments){
            const id=p.transaction_id.slice('prodamus:'.length);
            await saveRecord(c,{id:digest('prodamus:'+id),kind:'payment',provider:'prodamus',provider_id:id,
              order_id:p.order_id,buyer_email:p.buyer_email,amount_cents:p.amount_cents,currency:'RUB',
              tariff:p.tariff,status:'paid',source_status:'Оплата подтверждена',
              occurred_at:new Date(p.paid_at||p.created_at).toISOString(),source:'platform',
              record_key:'platform-payment:'+p.transaction_id});
          }
          const orders=(await c.query(`SELECT order_id,buyer_email,amount_cents,tariff,created_at
            FROM club_cp_orders o WHERE payment_provider='prodamus' AND NOT test_mode
              AND NOT EXISTS(SELECT 1 FROM club_history_events e WHERE e.record_key='platform-checkout:'||o.order_id)
            ORDER BY created_at LIMIT 500`)).rows;
          for(const o of orders)await saveRecord(c,{kind:'lead',provider:'prodamus',provider_id:o.order_id,
            order_id:o.order_id,buyer_email:o.buyer_email,amount_cents:o.amount_cents,currency:'RUB',
            tariff:o.tariff,status:'lead',source_status:'Создан заказ на платформе',
            occurred_at:new Date(o.created_at).toISOString(),source:'platform',record_key:'platform-checkout:'+o.order_id});
          await c.query('UPDATE club_history_sync SET last_success_at=now(),last_error=NULL WHERE id=1');
          return {payments:payments.length,leads:orders.length};
        },{tryLock:true});
      }catch(error){
        await pool.query("UPDATE club_history_sync SET last_error='local_reconciliation_unavailable' WHERE id=1").catch(()=>{});
        throw error;
      }
    },
    async list({kind='payments',q='',page=1,status='all'}={}){
      const leads=kind==='leads';
      page=Math.max(1,Math.min(10000,parseInt(page,10)||1));
      const term=String(q).trim().slice(0,120).replace(/[\\%_]/g,'\\$&');
      const filter=['paid','refunded','failed'].includes(status)?status:'all';
      const from=leads?'club_history_events h':`club_payment_history h ${mailJoin}`;
      const where=`(${leads?"h.kind='lead'":'true'})
        AND ($1::text='' OR h.buyer_email ILIKE '%'||$1||'%' OR h.order_id ILIKE '%'||$1||'%'
          OR h.provider_id ILIKE '%'||$1||'%')
        AND (${leads?'true':`($2::text='all' OR ($2='paid' AND h.status IN('paid','received','settled'))
          OR ($2='refunded' AND h.status IN('refunded','partially_refunded')) OR ($2='failed' AND h.status='failed'))`})`;
      // Keep parameter arity fixed for both views.
      const predicate=leads?where+" AND $2::text IS NOT NULL":where;
      const args=[term,filter];
      const total=Number((await pool.query(`SELECT count(*)::integer AS n FROM ${from} WHERE ${predicate}`,args)).rows[0].n);
      const items=(await pool.query(`SELECT ${leads?"h.*,'not_verified' AS mail_status":projection}
        FROM ${from} WHERE ${predicate} ORDER BY h.occurred_at DESC,h.id DESC LIMIT 25 OFFSET $3`,[...args,(page-1)*25])).rows;
      const summary=(await pool.query(`SELECT count(*)::integer AS payments,
        count(*) FILTER(WHERE status IN('paid','received','settled'))::integer AS paid,
        count(*) FILTER(WHERE status IN('refunded','partially_refunded'))::integer AS refunded,
        (SELECT count(*)::integer FROM club_history_events WHERE kind='lead') AS leads
        FROM club_payment_history`)).rows[0];
      const sync=(await pool.query('SELECT * FROM club_history_sync WHERE id=1')).rows[0];
      return {items:items.map(x=>({...x,kind:leads?'lead':'payment'})),total,page,pageSize:25,summary,
        sync:{...sync,limits_note:limitsNote},coverage:await readHistoryCoverage(pool),generatedAt:new Date().toISOString()};
    },
    async detail(id,{kind='payments'}={}){
      if(!/^[a-f0-9]{64}$/.test(id))throw new SupportError('Запись не найдена',404);
      const leads=kind==='leads';
      const item=(await pool.query(leads
        ?`SELECT h.*,'not_verified' AS mail_status FROM club_history_events h WHERE h.id=$1 AND h.kind='lead'`
        :`SELECT ${projection},o.order_id AS live_order_id FROM club_payment_history h ${mailJoin} WHERE h.id=$1`,[id])).rows[0];
      if(!item)throw new SupportError('Запись не найдена',404);
      const events=(await pool.query(`SELECT kind,provider_id,source_status,occurred_at,source,occurrences
        FROM club_history_events WHERE (order_id=$1 AND $1::text IS NOT NULL) OR
          (provider=$2 AND provider_id=$3 AND kind='payment')
        ORDER BY occurred_at DESC,id DESC LIMIT 200`,[item.order_id,item.provider,item.provider_id])).rows;
      return {item:{...item,kind:leads?'lead':'payment'},events,mail_status:item.mail_status,
        live_order_id:item.live_order_id||null};
    }
  };
}

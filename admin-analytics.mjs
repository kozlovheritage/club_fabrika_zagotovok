// Read-only reporting. No fulfillment, email calls, or provider API requests.
export async function readHistoryCoverage(client){
  const range=(await client.query(`SELECT min(occurred_at) AS earliest,max(occurred_at) AS latest
    FROM (SELECT occurred_at FROM club_history_events UNION ALL
      SELECT occurred_at FROM club_payment_history) saved`)).rows[0];
  const sync=(await client.query('SELECT * FROM club_history_sync WHERE id=1')).rows[0]||{};
  return {...range,last_success_at:sync.last_success_at||null,last_import_at:sync.last_import_at||null,
    import_min:sync.import_counts?.minDate||null,import_max:sync.import_counts?.maxDate||null};
}

const moneyRows=`WITH money AS (
  SELECT h.provider,h.provider_id,h.amount_cents,
    CASE WHEN h.status IN ('refunded','partially_refunded') THEN h.status
      WHEN reversal.has_refund THEN 'refund_reported'
      WHEN reversal.needs_review THEN 'review' ELSE h.status END AS status,
    h.occurred_at,h.identity_conflict
    FROM club_payment_history h
    LEFT JOIN LATERAL(
      SELECT bool_or(e.event_type='refund') AS has_refund,
        bool_or(e.event_type IN ('cancel','refund_failed')) AS needs_review
      FROM club_cp_orders o JOIN club_cp_payment_events e ON e.order_id=o.order_id
      WHERE NOT o.test_mode AND o.payment_provider=h.provider AND e.payment_provider=o.payment_provider
        AND o.buyer_email=h.buyer_email AND o.amount_cents=h.amount_cents
        AND (e.currency IS NULL OR e.currency=h.currency)
        AND (o.order_id=h.order_id OR (h.provider='cloudpayments' AND EXISTS(
          SELECT 1 FROM club_cp_payments p WHERE p.order_id=o.order_id
            AND p.transaction_id=h.provider_id AND p.outcome='fulfilled')))
        AND e.event_type IN ('refund','cancel','refund_failed')
        AND (COALESCE(e.original_transaction_id,e.transaction_id) IS NULL
          OR COALESCE(e.original_transaction_id,e.transaction_id)=h.provider_id)
    ) reversal ON NOT h.identity_conflict
    WHERE h.currency='RUB'
      AND NOT EXISTS(SELECT 1 FROM club_cp_orders t WHERE t.order_id=h.order_id AND t.test_mode)
  UNION ALL
  SELECT 'cloudpayments',p.transaction_id,o.amount_cents,
    CASE WHEN reversal.has_refund THEN 'refund_reported'
      WHEN reversal.needs_review THEN 'review' ELSE 'paid' END,
    COALESCE(o.paid_at,p.created_at),false
    FROM club_cp_payments p JOIN club_cp_orders o USING(order_id)
    LEFT JOIN LATERAL(
      SELECT bool_or(e.event_type='refund') AS has_refund,
        bool_or(e.event_type IN ('cancel','refund_failed')) AS needs_review
      FROM club_cp_payment_events e
      WHERE e.order_id=o.order_id AND e.payment_provider=o.payment_provider
        AND (e.currency IS NULL OR e.currency='RUB')
        AND e.event_type IN ('refund','cancel','refund_failed')
        AND (COALESCE(e.original_transaction_id,e.transaction_id) IS NULL
          OR COALESCE(e.original_transaction_id,e.transaction_id)=p.transaction_id)
    ) reversal ON true
    WHERE NOT o.test_mode AND o.payment_provider='cloudpayments' AND p.outcome='fulfilled'
      AND NOT EXISTS(SELECT 1 FROM club_payment_history h
        WHERE h.provider='cloudpayments' AND h.provider_id=p.transaction_id)
), windowed AS (SELECT * FROM money WHERE ($1::timestamptz IS NULL OR occurred_at>=$1) AND occurred_at<=$2)`;

export async function readAdminAnalytics(pool,inputPeriod='30'){
  const period=['7','30','all'].includes(String(inputPeriod))?String(inputPeriod):'30';
  const client=await pool.connect();
  try{
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const window=(await client.query(`SELECT now() AS until,
      CASE WHEN $1::text IS NULL THEN NULL ELSE
        (date_trunc('day',now() AT TIME ZONE 'Europe/Moscow')-make_interval(days=>$1::integer-1))
          AT TIME ZONE 'Europe/Moscow' END AS since`,[period==='all'?null:period])).rows[0];
    // CASE cannot cast 'all' to integer, so NULL represents the unbounded case.
    const args=[window.since,window.until];
    const summary=(await client.query(`${moneyRows} SELECT
      COALESCE(sum(amount_cents) FILTER(WHERE status IN ('paid','received','settled') AND NOT identity_conflict),0)::text AS amount_cents,
      count(*) FILTER(WHERE status IN ('paid','received','settled') AND NOT identity_conflict)::integer AS count,
      count(*) FILTER(WHERE status='refunded' AND NOT identity_conflict)::integer AS full_count,
      count(*) FILTER(WHERE status='partially_refunded' AND NOT identity_conflict)::integer AS partial_count,
      count(*) FILTER(WHERE status='refund_reported' AND NOT identity_conflict)::integer AS reported_count,
      count(*) FILTER(WHERE identity_conflict)::integer AS identity_conflicts FROM windowed`,args)).rows[0];
    const daily=(await client.query(`${moneyRows}
      SELECT to_char(occurred_at AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') AS day,
        sum(amount_cents)::text AS amount_cents,count(*)::integer AS count FROM windowed
      WHERE status IN ('paid','received','settled') AND NOT identity_conflict
      GROUP BY day ORDER BY day`,args)).rows;
    const providers=(await client.query(`${moneyRows}
      SELECT provider,sum(amount_cents)::text AS amount_cents,count(*)::integer AS count FROM windowed
      WHERE status IN ('paid','received','settled') AND NOT identity_conflict
      GROUP BY provider ORDER BY provider`,args)).rows;
    const groups=(await client.query(`WITH observed AS (
      SELECT e.payment_provider AS provider,e.transaction_id,e.event_id,e.error_code,
        min(e.created_at) OVER(PARTITION BY e.payment_provider,COALESCE(e.transaction_id,'event:'||e.event_id)) AS occurred_at,
        row_number() OVER(PARTITION BY e.payment_provider,COALESCE(e.transaction_id,'event:'||e.event_id)
          ORDER BY e.created_at DESC,e.event_id DESC) AS n
      FROM club_cp_payment_events e JOIN club_cp_orders o USING(order_id)
      WHERE NOT o.test_mode AND e.payment_provider=o.payment_provider AND e.event_type='fail'
    ), attempts AS (
      SELECT provider,CASE WHEN error_code ~ '^[A-Za-z0-9_-]{1,40}$' THEN error_code ELSE NULL END AS reason_code,occurred_at
        FROM observed WHERE n=1
      UNION ALL
      SELECT h.provider,NULL,h.occurred_at FROM club_payment_history h
        WHERE h.status='failed' AND NOT h.identity_conflict
          AND NOT EXISTS(SELECT 1 FROM club_cp_orders t WHERE t.order_id=h.order_id AND t.test_mode)
          AND NOT EXISTS(SELECT 1 FROM observed e WHERE e.provider=h.provider AND e.transaction_id=h.provider_id)
    ) SELECT provider,reason_code,count(*)::integer AS count FROM attempts
      WHERE ($1::timestamptz IS NULL OR occurred_at>=$1) AND occurred_at<=$2
      GROUP BY provider,reason_code ORDER BY count DESC,provider,reason_code NULLS LAST`,args)).rows;
    const coverage=await readHistoryCoverage(client);
    await client.query('COMMIT');
    return {generatedAt:new Date(window.until).toISOString(),period,
      window:{from:window.since,to:window.until},
      collection:{amount_cents:summary.amount_cents,count:summary.count,daily,by_provider:providers,
        refunds:{full_count:summary.full_count,partial_count:summary.partial_count,reported_count:summary.reported_count}},
      failures:{count:groups.reduce((n,g)=>n+g.count,0),groups:groups.map(g=>({...g,
        label:g.reason_code?'Код отказа '+g.reason_code:'Причина не передана'}))},
      coverage,excluded:{identity_conflicts:summary.identity_conflicts},
      limits_note:'Только сохранённые подтверждения. Сумма включает текущие успешные оплаты без записей возвратов и конфликтов; это не чистая выручка. Точная сумма частичного возврата может отсутствовать. Оформления, отмены и неизвестная доставка не считаются отказами оплаты. Даты — Москва. Полный журнал провайдера не опрашивается.'};
  }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally{client.release();}
}

import {PAYMENT_REVIEW_SQL,ATTENTION_SQL,CLOSED_UNPAID_SQL} from './mail-monitor.mjs';

// Presentation classification only. The existing alert and fulfillment logic
// remains unchanged; absence of delivery evidence is not a transport failure.
export const QUEUE_CATEGORY_SQL=`CASE
  WHEN ${CLOSED_UNPAID_SQL} THEN 'closed_unpaid'
  WHEN o.status='review' OR ${PAYMENT_REVIEW_SQL} OR
    to_jsonb(o)->>'last_payment_status' IN
      ('failed','canceled','refund_reported','refunded','partially_refunded','refund_failed','unknown','duplicate')
    THEN 'payment_review'
  WHEN o.status='paid' AND to_jsonb(o)->>'access_confirmed_at' IS NOT NULL THEN 'accepted'
  WHEN o.status='paid' AND m.delivery_status='delivered' AND NOT COALESCE(${ATTENTION_SQL},false) THEN 'accepted'
  WHEN o.status='paid' AND (m.order_id IS NULL OR m.last_error_code='credentials_review') THEN 'access_review'
  WHEN o.status='paid' AND m.delivery_status IN ('skipped','soft_bounced','hard_bounced') THEN 'mail_error'
  WHEN o.status='paid' AND m.last_error_code IN
    ('provider_auth','provider_rate_limit','provider_rejected','temporary_send_failure') THEN 'mail_error'
  WHEN o.status='paid' AND
    (m.last_error_code IN ('external_delivery_unverified','send_uncertain','status_unavailable')
      OR m.delivery_status='unknown'
      OR (m.state='accepted' AND COALESCE(${ATTENTION_SQL},false))) THEN 'unverified'
  WHEN o.status='paid' AND COALESCE(${ATTENTION_SQL},false) THEN 'mail_error'
  ELSE 'progress' END`;

export const QUEUE_PRIORITY_SQL=`CASE (${QUEUE_CATEGORY_SQL})
  WHEN 'payment_review' THEN 0 WHEN 'access_review' THEN 1
  WHEN 'mail_error' THEN 2 WHEN 'unverified' THEN 3 ELSE 4 END`;

export function describeQueue(order){
  const category=order.queue_category;
  const native=order.provider==='prodamus'&&order.last_error_code==='external_delivery_unverified';
  const copy={
    closed_unpaid:['Проверено: оплаты нет','Заказ сохранён в истории. Проверка закрыта владельцем; новые события оплаты будут проверены заново.'],
    payment_review:['Оплата требует проверки','Откройте события оплаты; проверьте отказ, возврат или расхождение у платёжного сервиса.'],
    access_review:['Выдача доступа требует проверки','Проверьте учётную запись и актуальные данные входа в карточке заказа.'],
    mail_error:['Подтверждённый сбой письма','Проверьте причину отказа и адрес; повторяйте только после проверки или просьбы участника.'],
    unverified:native
      ?['Prodamus не передаёт подтверждение доставки','Уточните получение у участника; если доступ получен, подтвердите это вручную.']
      :['Нет подтверждения доставки','Проверьте статус у почтового сервиса или уточните получение; не повторяйте вслепую.'],
    accepted:[order.access_confirmed_at?'Получение подтверждено вами':'Принято почтовым сервером','Дополнительных действий не требуется. Приём сервером не гарантирует попадание во входящие.'],
    progress:['Ожидает оплаты или обработки','Дождитесь оплаты/обработки; отсутствие завершённой оплаты не означает отказ.']
  };
  const [queue_reason,next_action]=copy[category]||copy.progress;
  return {...order,queue_reason,next_action};
}

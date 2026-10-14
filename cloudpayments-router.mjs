import {createPaymentLink,validWebhookHmac,parseWebhook,validateNotification,cents,CloudPaymentsError} from './cloudpayments.mjs';

// Mount BEFORE the application's JSON/form parsers to preserve signed bytes.
export function mountCloudNotifications(app, express, service) {
  const router=express.Router();
  router.use(express.raw({type:['application/json','application/x-www-form-urlencoded'],limit:'64kb'}));
  router.post('/:kind',async(req,res,next)=>{
    try{
      const result=await service.notification(req.params.kind,req.body,
        req.get('Content-Type')||'',req.get('Content-HMAC'));
      res.set('Cache-Control','no-store').json(result);
    }catch(error){
      if(error instanceof CloudPaymentsError)return res.status(error.status).json({message:error.message});
      next(error);
    }
  });
  app.use('/api/webhooks/cloudpayments',router);
}

export function createCloudService(config, store, {siteUrl, fetcher} = {}) {
  return {
    async create(checkout, tariff) {
      if (!config.enabled) throw new CloudPaymentsError('CloudPayments пока не подключён');
      await store.saveOrder(checkout,tariff);
      const order = await store.getOrder(checkout.order_id);
      if (!order || order.status!=='pending') throw new CloudPaymentsError('Этот заказ уже обработан',409);
      let url=order.payment_url;
      try{url ||= await createPaymentLink(checkout,siteUrl,config,fetcher);}
      catch(error){
        await store.recordProviderEvent({orderId:order.order_id,provider:'cloudpayments',
          type:'unknown',status:'unknown',errorCode:'checkout_link_unavailable',
          amountCents:Number(order.amount_cents),currency:'RUB'});
        throw error;
      }
      await store.saveUrl(checkout.order_id,url);
      // Never return credentials, receipt settings, Public ID or API secret to checkout.
      return {provider:'cloudpayments',order_id:checkout.order_id,paymentUrl:url};
    },
    async notification(kind, raw, contentType, hmac) {
      if (!config.enabled || !config.secret) throw new CloudPaymentsError('CloudPayments пока не подключён');
      if (!['check','pay','confirm','fail','cancel','refund'].includes(kind))
        throw new CloudPaymentsError('Неизвестное уведомление',404);
      if (!validWebhookHmac(raw,hmac,config.secret)) throw new CloudPaymentsError('Неверная подпись',401);
      let payload;
      try { payload=parseWebhook(raw,contentType); }
      catch { throw new CloudPaymentsError('Некорректное уведомление',400); }
      const order = await store.getOrder(String(payload.InvoiceId||''));
      // Refund/Cancel have no required Currency/TestMode fields in the official
      // contract. Refund TransactionId is NEW; PaymentTransactionId is original.
      if(kind==='refund'||kind==='cancel'){
        const amount=cents(payload.Amount),transactionId=String(payload.TransactionId||'');
        const originalTransactionId=kind==='refund'?String(payload.PaymentTransactionId||''):transactionId;
        if(!order||order.test_mode!==config.test||
          (payload.AccountId!=null&&payload.AccountId!==order.order_id)||
          !/^[1-9]\d{0,24}$/.test(transactionId)||!/^[1-9]\d{0,24}$/.test(originalTransactionId)||
          !amount||amount>Number(order.amount_cents)||
          (kind==='refund'&&payload.OperationType!=='Refund')||
          (kind==='cancel'&&amount!==Number(order.amount_cents)))
          throw new CloudPaymentsError('Не удалось проверить возврат или отмену',422);
        await store.recordProviderEvent({orderId:order.order_id,provider:'cloudpayments',type:kind,
          status:kind==='refund'?'refunded':'canceled',transactionId,originalTransactionId,
          amountCents:amount,currency:'RUB',eventTime:String(payload.DateTime||'')});
        return {code:0};
      }
      const validation = validateNotification(payload,order,config);
      if (order && order.test_mode!==config.test) validation.code=10;
      if (kind==='check') return {code:order?.status!=='pending'?10:validation.code};
      if (validation.code) throw new CloudPaymentsError('Не удалось проверить платёж',422);
      if(kind==='fail'){
        const type=payload.OperationType==='Payment'?'fail':payload.OperationType==='Refund'?'refund_failed':'unknown';
        await store.recordProviderEvent({orderId:order.order_id,provider:'cloudpayments',type,
          status:type==='fail'?'failed':type,transactionId:validation.transactionId,
          amountCents:Number(order.amount_cents),currency:'RUB',
          errorCode:kind==='fail'?String(payload.ReasonCode||'').slice(0,60):null,
          eventTime:String(payload.DateTime||'')});
        return {code:0};
      }
      // Authorized is only a hold: never grant access before Completed/capture.
      if (kind==='pay' && payload.Status==='Authorized'){
        await store.recordProviderEvent({orderId:order.order_id,provider:'cloudpayments',type:'authorized',
          status:'authorized',transactionId:validation.transactionId,
          amountCents:Number(order.amount_cents),currency:'RUB',eventTime:String(payload.DateTime||'')});
        return {code:0};
      }
      if (payload.Status!=='Completed'){
        await store.recordProviderEvent({orderId:order.order_id,provider:'cloudpayments',type:'unknown',
          status:'unknown',transactionId:validation.transactionId,
          amountCents:Number(order.amount_cents),currency:'RUB',errorCode:'unrecognized_status',
          eventTime:String(payload.DateTime||'')});
        return {code:0};
      }
      await store.fulfill(order.order_id,validation.transactionId);
      return {code:0};
    }
  };
}

import {createPaymentLink,validWebhookHmac,parseWebhook,validateNotification,CloudPaymentsError} from './cloudpayments.mjs';

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
      const url = order.payment_url || await createPaymentLink(checkout,siteUrl,config,fetcher);
      await store.saveUrl(checkout.order_id,url);
      // Never return credentials, receipt settings, Public ID or API secret to checkout.
      return {provider:'cloudpayments',order_id:checkout.order_id,paymentUrl:url};
    },
    async notification(kind, raw, contentType, hmac) {
      if (!config.enabled || !config.secret) throw new CloudPaymentsError('CloudPayments пока не подключён');
      if (!['check','pay','confirm'].includes(kind)) throw new CloudPaymentsError('Неизвестное уведомление',404);
      if (!validWebhookHmac(raw,hmac,config.secret)) throw new CloudPaymentsError('Неверная подпись',401);
      let payload;
      try { payload=parseWebhook(raw,contentType); }
      catch { throw new CloudPaymentsError('Некорректное уведомление',400); }
      const order = await store.getOrder(String(payload.InvoiceId||''));
      const validation = validateNotification(payload,order,config);
      if (order && order.test_mode!==config.test) validation.code=10;
      if (kind==='check') return {code:order?.status!=='pending'?10:validation.code};
      if (validation.code) throw new CloudPaymentsError('Не удалось проверить платёж',422);
      // Authorized is only a hold: never grant access before Completed/capture.
      if (kind==='pay' && payload.Status==='Authorized') return {code:0};
      if (payload.Status!=='Completed') throw new CloudPaymentsError('Оплата не завершена',422);
      await store.fulfill(order.order_id,validation.transactionId);
      return {code:0};
    }
  };
}

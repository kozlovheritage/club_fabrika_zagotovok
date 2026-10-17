import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readCloudConfig,cents,validWebhookHmac,parseWebhook,validateNotification,
  createPaymentLink,receiptInstructions,validPaymentUrl} from './cloudpayments.mjs';
import {createCloudService} from './cloudpayments-router.mjs';
import {createCheckout,quotePrice} from './checkout.mjs';

const config={
  enabled:true,publicId:'synthetic-public',secret:'synthetic-test-secret',test:true,terminalConfirmed:true,
  receiptApproved:true,
  // Synthetic forwarding fixture, NOT an approved production fiscal schema.
  receiptTemplate:JSON.stringify({cloudpayments:{syntheticReceipt:{
    email:'$email',amount:'$amount',label:'$product'}}})
};
const checkout=createCheckout('premium','synthetic-checkout-signing-key',{},
  'buyer@example.test','FABRIKA1R','Тестовая Участница');
const amount=Number(checkout.products[0].price);
const order={order_id:checkout.order_id,amount_cents:Math.round(amount*100),test_mode:true,status:'pending'};
const payload={InvoiceId:order.order_id,AccountId:order.order_id,Amount:checkout.products[0].price,
  Currency:'RUB',TestMode:'1',TransactionId:'123456789',Status:'Completed'};
const signed=value=>{
  const raw=Buffer.from(new URLSearchParams(value).toString());
  return {raw,hmac:crypto.createHmac('sha256',config.secret).update(raw).digest('base64')};
};

test('defaults preserve Prodamus; integration disabled, test mode, fiscal gate closed',()=>{
  const value=readCloudConfig({});
  assert.equal(value.enabled,false);assert.equal(value.test,true);assert.equal(value.receiptApproved,false);
  assert.throws(()=>readCloudConfig({CLOUDPAYMENTS_MODE:'arbitrary'}));
});
test('integer kopecks, no exponent/negative/precision ambiguity',()=>{
  assert.equal(cents('5990.00'),599000);
  for(const value of ['5.999','5e3','-1','0','1,00','90071992547409999'])
    assert.equal(cents(value),null);
});
test('tariffs and all current promo types are preserved without client prices',()=>{
  for(const tariff of ['basic','premium'])
    for(const promo of ['', 'FABRIKA1R','FABRIKA1B','FABRIKA2PR','FABRIKAB2P','SKIDKA1C','SKIDKA1C SKIDKA1C']){
      const name=tariff==='premium'?'Тестовая Участница':undefined;
      const c=createCheckout(tariff,'test-key',{},'buyer@example.test',promo,name);
      assert.equal(cents(c.products[0].price),quotePrice(tariff,promo).priceRub*100);
    }
});
test('Content-HMAC verifies original encoded bytes, not decoded text',()=>{
  const {raw,hmac}=signed({...payload,Email:'Ирина+test@example.test'});
  assert.equal(validWebhookHmac(raw,hmac,config.secret),true);
  assert.equal(validWebhookHmac(Buffer.from(decodeURIComponent(raw.toString())),hmac,config.secret),false);
  assert.equal(validWebhookHmac(raw,hmac,'wrong-secret'),false);
  assert.equal(validWebhookHmac(raw,hmac.slice(1),config.secret),false);
  assert.equal(validWebhookHmac(null,hmac,config.secret),false);
  assert.equal(parseWebhook(raw,'application/x-www-form-urlencoded').Email,'Ирина+test@example.test');
});
test('duplicate form fields and malformed/non-object JSON are rejected',()=>{
  assert.throws(()=>parseWebhook(Buffer.from('Amount=1&Amount=2'),'application/x-www-form-urlencoded'));
  for(const body of ['[1]','null','{'])assert.throws(()=>parseWebhook(Buffer.from(body),'application/json'));
  assert.throws(()=>parseWebhook(Buffer.from('{}'),'text/plain'));
});
test('order, currency, amount, account, transaction and test/live are validated',()=>{
  assert.equal(validateNotification(payload,order,config).code,0);
  for(const patch of [{Amount:(amount-0.01).toFixed(2)},{Currency:'USD'},{AccountId:'other'},
    {InvoiceId:'other'},{TestMode:'0'},{TestMode:'yes'},{TransactionId:'NaN'},
    {TransactionId:Number.MAX_SAFE_INTEGER+1}]){
    assert.notEqual(validateNotification({...payload,...patch},order,config).code,0);
  }
});
test('missing merchant credentials and unapproved fiscal configuration block API calls',async()=>{
  let called=false;const fetcher=()=>{called=true;throw new Error('must not call');};
  for(const patch of [{enabled:false},{secret:''},{terminalConfirmed:false},{receiptApproved:false},{receiptTemplate:''}]){
    await assert.rejects(createPaymentLink(checkout,'https://club.example.test',{...config,...patch},fetcher));
  }
  assert.equal(called,false);
});
test('invoice is created on server: no confirmation, provider access mail, or recurring subscription',async()=>{
  let request;
  const fetcher=async(url,options)=>{
    request={url,options,body:JSON.parse(options.body)};
    return {ok:true,json:async()=>({Success:true,Model:{Url:'https://orders.cloudpayments.ru/d/fixture',Amount:amount,Currency:'RUB'}})};
  };
  assert.equal(await createPaymentLink(checkout,'https://club.example.test',config,fetcher),'https://orders.cloudpayments.ru/d/fixture');
  assert.equal(request.url,'https://api.cloudpayments.ru/orders/create');
  assert.equal(request.body.InvoiceId,checkout.order_id);
  assert.equal(request.body.AccountId,checkout.order_id);
  assert.equal(request.body.RequireConfirmation,false);
  assert.equal(request.body.SendEmail,false);
  assert.equal(request.body.SubscriptionBehavior,undefined);
  assert.equal(request.body.JsonData.cloudpayments.syntheticReceipt.amount,amount);
  assert.ok(request.options.headers['X-Request-ID']);
  assert.equal(receiptInstructions(checkout,config).cloudpayments.syntheticReceipt.email,'buyer@example.test');
});
test('untrusted links, unsuccessful response, wrong amount/currency and timeouts fail closed',async()=>{
  for(const url of ['http://orders.cloudpayments.ru/d/a','https://evil.test/d/a',
    'https://orders.cloudpayments.ru.evil.test/d/a','https://evil@orders.cloudpayments.ru/d/a',
    'https://orders.cloudpayments.ru/d/a?url=evil','javascript:alert(1)'])assert.equal(validPaymentUrl(url),false);
  const good={Success:true,Model:{Url:'https://orders.cloudpayments.ru/d/a',Amount:amount,Currency:'RUB'}};
  for(const value of [{...good,Success:false},{...good,Model:{...good.Model,Amount:1}},
    {...good,Model:{...good.Model,Currency:'USD'}},{...good,Model:{...good.Model,Url:'https://evil.test/d/a'}}]){
    await assert.rejects(createPaymentLink(checkout,'https://club.example.test',config,async()=>({ok:true,json:async()=>value})));
  }
  await assert.rejects(createPaymentLink(checkout,'https://club.example.test',config,async()=>{throw new Error('timeout');}));
});
test('Check validates but never fulfills; Authorized holds grant nothing; Confirm completes',async()=>{
  const granted=[];
  const store={getOrder:async()=>order,fulfill:async(...args)=>granted.push(args),recordProviderEvent:async()=>{}};
  const service=createCloudService(config,store);
  for(const [kind,data] of [['check',payload],['pay',{...payload,Status:'Authorized'}]]){
    const {raw,hmac}=signed(data);
    assert.deepEqual(await service.notification(kind,raw,'application/x-www-form-urlencoded',hmac),{code:0});
  }
  assert.equal(granted.length,0);
  const {raw,hmac}=signed(payload);
  await service.notification('confirm',raw,'application/x-www-form-urlencoded',hmac);
  assert.deepEqual(granted,[[order.order_id,'123456789']]);
});
test('invalid signatures, test/live mismatch and failed status never fulfill',async()=>{
  let count=0;
  const events=[];
  const service=createCloudService(config,{getOrder:async()=>order,fulfill:async()=>count++,recordProviderEvent:async event=>events.push(event)});
  const {raw}=signed(payload);
  await assert.rejects(service.notification('pay',raw,'application/x-www-form-urlencoded','invalid'));
  for(const patch of [{TestMode:'0'},{Amount:'1.00'}]){
    const data=signed({...payload,...patch});
    await assert.rejects(service.notification('pay',data.raw,'application/x-www-form-urlencoded',data.hmac));
  }
  const unknown=signed({...payload,Status:'Declined'});
  assert.deepEqual(await service.notification('pay',unknown.raw,'application/x-www-form-urlencoded',unknown.hmac),{code:0});
  assert.equal(events[0].type,'unknown');
  assert.equal(count,0);
});
test('checkout exposes only the hosted link and order ID; cached link is reused',async()=>{
  let count=0;let saved;
  const service=createCloudService(config,{
    saveOrder:async()=>{},getOrder:async()=>({...order,payment_url:'https://orders.cloudpayments.ru/d/cached'}),
    saveUrl:async(id,url)=>{saved={id,url};}
  },{siteUrl:'https://club.example.test',fetcher:()=>{count++;}});
  const response=await service.create(checkout,'premium');
  assert.deepEqual(Object.keys(response).sort(),['order_id','paymentUrl','provider']);
  assert.equal(response.paymentUrl,'https://orders.cloudpayments.ru/d/cached');
  assert.equal(saved.id,order.order_id);assert.equal(count,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {createCheckout,restoreCheckout,premiumPasswordForOrder,identifyCheckout} from './checkout.mjs';
import {buildDirectPaymentForm,MERCHANT_FORM} from './payment-recovery.mjs';

const key = 'test-order-signing-key';
function sign(payload) {
  const normalize = value => Array.isArray(value) ? value.map(normalize) :
    value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k,normalize(value[k])])) : String(value);
  return crypto.createHmac('sha256','test-prodamus-key')
    .update(JSON.stringify(normalize(payload)).replace(/\//g,'\\/')).digest('hex');
}
for (const tariff of ['premium','basic']) {
  test(`${tariff}: recovery preserves order, coupon price, buyer, content and webhook identity`, () => {
    const first = createCheckout(tariff,key,{},'synthetic@example.invalid','FABRIKA1R',tariff === 'premium' ? 'Тест Оплаты' : undefined);
    const restored = restoreCheckout(first.order_id,key,first.customer_email,first.customer_name);
    assert.deepEqual(restored,first);
    restored.paid_content = tariff === 'premium' ? 'Test unique unpaid credentials' : 'Test payment-gated club URL';
    const form = buildDirectPaymentForm(restored,sign);
    const fields = Object.fromEntries(form.fields.map(f => [f.name,f.value]));
    assert.equal(form.action,MERCHANT_FORM);
    assert.equal(form.method,'POST');
    assert.equal(fields.order_id,first.order_id);
    assert.equal(fields['products[0][price]'],first.products[0].price);
    assert.equal(fields['products[0][quantity]'],'1');
    assert.equal(fields.customer_email,first.customer_email);
    assert.equal(fields.paid_content,restored.paid_content);
    assert.equal(fields.do,'pay');
    assert.equal(fields.signature,sign({...first,paid_content:restored.paid_content,do:'pay',sys:''}));
    assert.equal(fields.demo_mode,undefined);
    assert.equal(fields.urlNotification,undefined);
    assert.equal(fields.urlSuccess,undefined);
    assert.equal(identifyCheckout({order_num:first.order_id,customer_email:first.customer_email,
      products:first.products,sum:first.products[0].price},key).kind,'site');
    if(tariff === 'premium') assert.equal(premiumPasswordForOrder(restored.order_id,key),premiumPasswordForOrder(first.order_id,key));
  });
  test(`${tariff}: tampered order or other email cannot recover`, () => {
    const first=createCheckout(tariff,key,{},'synthetic@example.invalid','',tariff === 'premium' ? 'Тест Оплаты' : undefined);
    assert.equal(restoreCheckout(first.order_id.replace(/-[0-9]+-/, '-100-'),key,first.customer_email,first.customer_name),null);
    assert.equal(restoreCheckout(first.order_id,key,'other@example.invalid',first.customer_name),null);
    assert.equal(restoreCheckout(first.order_id,'wrong-key',first.customer_email,first.customer_name),null);
  });
}
test('previously signed discounted orders remain recoverable after a code is retired', () => {
  for (const [tariff,price] of [['premium',599000],['basic',519000]]) {
    const first=createCheckout(tariff,key,{},'synthetic@example.invalid','FABRIKA1R',tariff==='premium'?'Тест Оплаты':undefined);
    const prefix=first.order_id.split('-').slice(0,-1).join('-').replace(/^(fz[34]-[bp]-)\d+-/,'$1'+price+'-');
    const version=prefix.startsWith('fz4-')?'v4':'v3';
    const signature=crypto.createHmac('sha256',key).update('club-checkout-'+version+':'+prefix).digest('hex').slice(0,24);
    const orderId=prefix+'-'+signature;
    const restored=restoreCheckout(orderId,key,first.customer_email,first.customer_name);
    assert.equal(restored.order_id,orderId);
    assert.equal(restored.products[0].price,(price/100).toFixed(2));
    assert.equal(identifyCheckout({order_num:orderId,customer_email:first.customer_email,
      products:restored.products,sum:restored.products[0].price},key).kind,'site');
  }
});
test('recovery fails closed and does not accept arbitrary destinations or HTML', () => {
  assert.equal(restoreCheckout('external-order',key,'synthetic@example.invalid','Тест Оплаты'),null);
  const first=createCheckout('premium',key,{},'synthetic@example.invalid','','Тест Оплаты');
  assert.equal(restoreCheckout(first.order_id,key,first.customer_email,'Тест'),null);
  assert.throws(()=>buildDirectPaymentForm({...first,paid_content:'<script>example</script>'},()=> 'bad'));
  const form=buildDirectPaymentForm({...first,paid_content:'<script>example</script>',action:'https://evil.example/'},sign);
  assert.equal(form.action,MERCHANT_FORM);
  assert.equal(form.fields.find(f=>f.name==='paid_content').value,'<script>example</script>');
});

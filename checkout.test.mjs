import assert from 'node:assert/strict';
import test from 'node:test';
import {createCheckout, identifyCheckout} from './checkout.mjs';

const key = 'test-key-for-authenticated-order-identifiers';
const env = {BASIC_PRICE_RUB: '5900', PREMIUM_PRICE_RUB: '6800'};

for (const tariff of ['basic', 'premium']) {
  test(`${tariff}: only the expected paid product is accepted`, () => {
    const order = createCheckout(tariff, key, env);
    assert.ok(order);
    const notification = {order_id: '300155', order_num: order.order_id, products: order.products, sum: order.products[0].price};
    assert.deepEqual(identifyCheckout(notification, key, env), {kind: 'site', tariff});
    assert.equal(identifyCheckout({...notification, sum: '1.00'}, key, env).kind, 'invalid');
    assert.equal(identifyCheckout({...notification, products: [{...order.products[0], name: 'Other'}]}, key, env).kind, 'invalid');
    assert.equal(identifyCheckout({...notification, products: [{...order.products[0], price: '1.00'}]}, key, env).kind, 'invalid');
    assert.equal(identifyCheckout({...notification, order_num: order.order_id.slice(0, -1) + (order.order_id.endsWith('0') ? '1' : '0')}, key, env).kind, 'invalid');
  });
}

test('other Prodamus orders stay outside the site checkout flow', () => {
  assert.deepEqual(identifyCheckout({order_id: 'chatbot-order'}, key, env), {kind: 'external'});
  assert.equal(createCheckout('premium', key, {}), null);
});
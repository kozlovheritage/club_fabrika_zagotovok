import assert from 'node:assert/strict';
import test from 'node:test';
import {createCheckout, identifyCheckout, premiumPasswordForOrder, quotePrice, normalizeBuyerName} from './checkout.mjs';

const key = 'test-key-for-authenticated-order-identifiers';
const env = {BASIC_PRICE_RUB: '5900', PREMIUM_PRICE_RUB: '6800'};

test('each promotion has the agreed standalone price; only SKIDKA1C can repeat', () => {
  const prices = [
    ['', 6790, 5990],
    ['CLUBB3', 5990, 5190],
    ['FABRIKA1R', 3400, 2700],
    ['FABRIKA1B', 4500, 3500],
    ['FABRIKA2Pr', 1690, 1490],
    ['FABRIKAB2P', 2190, 1990],
    ['SKIDKA1C', 6200, 5400],
    ['SKIDKA1C SKIDKA1C', 5610, 4810]
  ];
  for (const [code, premium, basic] of prices) {
    assert.equal(quotePrice('premium', code).priceRub, premium, code + ' premium');
    assert.equal(quotePrice('basic', code).priceRub, basic, code + ' basic');
    const order = createCheckout('premium', key, env, 'buyer@example.org', code);
    assert.equal(order.products[0].price, premium.toFixed(2));
    assert.equal(identifyCheckout({
      order_num: order.order_id, customer_email: order.customer_email,
      products: order.products, sum: order.products[0].price
    }, key).kind, 'site');
  }
  for (const input of ['CLUBB3 SKIDKA1C', 'FABRIKA1B FABRIKA2Pr', 'SKIDKA1C SKIDKA1C SKIDKA1C', 'CLUBB3 CLUBB3', 'UNKNOWN']) {
    assert.throws(() => quotePrice('basic', input), /промокод|суммировать|кодов/i, input);
  }
});

for (const tariff of ['basic', 'premium']) {
  test(`${tariff}: only the expected paid product is accepted`, () => {
    const order = createCheckout(tariff, key, env);
    assert.ok(order);
    const notification = {order_id: '300155', order_num: order.order_id, products: order.products, sum: order.products[0].price};
    assert.deepEqual(identifyCheckout(notification, key), {kind: 'site', tariff});
    assert.deepEqual(identifyCheckout(notification, key, {BASIC_PRICE_RUB: '9900', PREMIUM_PRICE_RUB: '9900'}), {kind: 'site', tariff});
    assert.equal(identifyCheckout({...notification, sum: '1.00'}, key, env).kind, 'invalid');
    assert.equal(identifyCheckout({...notification, products: [{...order.products[0], name: 'Other'}]}, key, env).kind, 'invalid');
    assert.equal(identifyCheckout({...notification, products: [{...order.products[0], price: '1.00'}]}, key, env).kind, 'invalid');
    assert.equal(identifyCheckout({...notification, order_num: order.order_id.slice(0, -1) + (order.order_id.endsWith('0') ? '1' : '0')}, key, env).kind, 'invalid');
  });
}

test('other Prodamus orders stay outside the site checkout flow', () => {
  assert.deepEqual(identifyCheckout({order_id: 'chatbot-order'}, key, env), {kind: 'external'});
  assert.equal(createCheckout('premium', '', {}), null);
});

for (const tariff of ['basic', 'premium']) {
  test(`${tariff}: email-bound Prodamus order keeps tariff, price and recipient together`, () => {
    const order = createCheckout(tariff, key, env, 'Buyer@Example.org');
    assert.equal(order.customer_email, 'buyer@example.org');
    const paid = {
      order_id: 'prodamus-1942', order_num: order.order_id,
      customer_email: order.customer_email, products: order.products, sum: order.products[0].price
    };
    assert.deepEqual(identifyCheckout(paid, key), {
      kind: 'site', tariff, orderId: order.order_id, email: order.customer_email
    });
    assert.equal(identifyCheckout({...paid, customer_email: 'other@example.org'}, key).kind, 'invalid');
    assert.equal(identifyCheckout({...paid, sum: '1.00'}, key).kind, 'invalid');
    assert.equal(identifyCheckout({...paid, products: [{...order.products[0], name: 'Other'}]}, key).kind, 'invalid');
    assert.equal(identifyCheckout({...paid, order_num: order.order_id.slice(0, -1) + (order.order_id.endsWith('0') ? '1' : '0')}, key).kind, 'invalid');
  });
}

test('each premium order has a stable, different password, unavailable for basic', () => {
  const first = createCheckout('premium', key, env, 'buyer@example.org');
  const second = createCheckout('premium', key, env, 'buyer@example.org');
  assert.match(premiumPasswordForOrder(first.order_id, key), /^Fz-[A-Za-z0-9_-]{18}$/);
  assert.equal(premiumPasswordForOrder(first.order_id, key), premiumPasswordForOrder(first.order_id, key));
  assert.notEqual(premiumPasswordForOrder(first.order_id, key), premiumPasswordForOrder(second.order_id, key));
  assert.equal(premiumPasswordForOrder(createCheckout('basic', key, env, 'buyer@example.org').order_id, key), null);
  assert.equal(createCheckout('premium', key, env, 'not-an-email'), null);
});

test('buyer name must contain given name and surname', () => {
  assert.equal(normalizeBuyerName('  Анна   Петрова  '), 'Анна Петрова');
  assert.equal(normalizeBuyerName('Мария Анна Иванова-Петрова'), 'Мария Анна Иванова-Петрова');
  for (const value of ['', 'Анна', 'Анна 5', '<b>Анна Петрова</b>', 'X'.repeat(121) + ' Иванова', null]) {
    assert.equal(normalizeBuyerName(value), null);
  }
});

for (const tariff of ['basic', 'premium']) {
  test(`${tariff}: a named order retains verified price/email and requires the saved name`, () => {
    const order = createCheckout(tariff, key, env, 'Buyer@Example.org', 'SKIDKA1C', '  Анна   Петрова ');
    assert.match(order.order_id, /^fz4-/);
    assert.equal(order.customer_name, 'Анна Петрова');
    assert.equal(order.customer_email, 'buyer@example.org');
    const paid = {
      order_num: order.order_id, customer_email: order.customer_email,
      customer_name: 'Чужое Имя', products: order.products, sum: order.products[0].price
    };
    assert.deepEqual(identifyCheckout(paid, key), {
      kind: 'site', tariff, orderId: order.order_id, email: 'buyer@example.org', requiresSavedName: true
    });
    assert.equal(identifyCheckout({...paid, sum: '1.00'}, key).kind, 'invalid');
    assert.equal(identifyCheckout({...paid, customer_email: 'other@example.org'}, key).kind, 'invalid');
    assert.equal(createCheckout(tariff, key, env, 'buyer@example.org', '', 'Анна'), null);
    if (tariff === 'premium') assert.match(premiumPasswordForOrder(order.order_id, key), /^Fz-[A-Za-z0-9_-]{18}$/);
  });
}
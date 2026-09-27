import crypto from 'node:crypto';

const PRODUCTS = {
  basic: {name: 'Клуб «Фабрика заготовок» — Базовый', code: 'b'},
  premium: {name: 'Клуб «Фабрика заготовок» — Расширенный', code: 'p'}
};

function priceCents(value) {
  const input = String(value ?? '').trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(input)) return null;
  const [rubles, kopecks = ''] = input.split('.');
  const result = Number(rubles) * 100 + Number(kopecks.padEnd(2, '0'));
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

function configuredPrice(tariff, env) {
  const value = env[tariff === 'basic' ? 'BASIC_PRICE_RUB' : 'PREMIUM_PRICE_RUB'];
  return priceCents(value);
}

function orderSignature(prefix, key) {
  return crypto.createHmac('sha256', key).update('club-checkout-v1:' + prefix).digest('hex').slice(0, 32);
}

export function createCheckout(tariff, key, env = process.env) {
  const product = PRODUCTS[tariff];
  const cents = product && configuredPrice(tariff, env);
  if (!cents || !key) return null;
  const prefix = `fz1-${product.code}-${crypto.randomBytes(16).toString('hex')}`;
  return {
    order_id: `${prefix}-${orderSignature(prefix, key)}`,
    currency: 'rub',
    products: [{name: product.name, price: (cents / 100).toFixed(2), quantity: 1, type: 'service'}]
  };
}

export function identifyCheckout(payload, key, env = process.env) {
  // Prodamus calls its own payment ID "order_id"; the merchant's ID is "order_num".
  const orderId = String(payload.order_num || payload.order_id || '');
  if (!orderId.startsWith('fz1-')) return {kind: 'external'};
  const match = /^(fz1-([bp])-[0-9a-f]{32})-([0-9a-f]{32})$/.exec(orderId);
  if (!match || !key) return {kind: 'invalid'};
  const expected = orderSignature(match[1], key);
  if (!crypto.timingSafeEqual(Buffer.from(match[3], 'hex'), Buffer.from(expected, 'hex'))) return {kind: 'invalid'};
  const tariff = match[2] === 'b' ? 'basic' : 'premium';
  const cents = configuredPrice(tariff, env);
  const rawProducts = payload.products;
  const products = Array.isArray(rawProducts) ? rawProducts : rawProducts && typeof rawProducts === 'object' ? Object.values(rawProducts) : [];
  if (!cents || products.length !== 1 ||
      String(products[0]?.name ?? '') !== PRODUCTS[tariff].name ||
      priceCents(products[0]?.price) !== cents ||
      String(products[0]?.quantity ?? '') !== '1' ||
      priceCents(payload.sum) !== cents) return {kind: 'invalid'};
  return {kind: 'site', tariff};
}
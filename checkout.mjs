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
  return crypto.createHmac('sha256', key).update('club-checkout-v2:' + prefix).digest('hex').slice(0, 24);
}

export function createCheckout(tariff, key, env = process.env) {
  const product = PRODUCTS[tariff];
  const cents = product && configuredPrice(tariff, env);
  if (!cents || !key) return null;
  const prefix = `fz2-${product.code}-${cents}-${crypto.randomBytes(12).toString('hex')}`;
  return {
    order_id: `${prefix}-${orderSignature(prefix, key)}`,
    currency: 'rub',
    products: [{name: product.name, price: (cents / 100).toFixed(2), quantity: 1, type: 'service'}]
  };
}

export function identifyCheckout(payload, key) {
  // Prodamus calls its own payment ID "order_id"; the merchant's ID is "order_num".
  const orderId = String(payload.order_num || payload.order_id || '');
  if (!orderId.startsWith('fz')) return {kind: 'external'};
  const match = /^(fz2-([bp])-([1-9]\d{2,8})-[0-9a-f]{24})-([0-9a-f]{24})$/.exec(orderId);
  if (!match || !key) return {kind: 'invalid'};
  const expected = orderSignature(match[1], key);
  if (!crypto.timingSafeEqual(Buffer.from(match[4], 'hex'), Buffer.from(expected, 'hex'))) return {kind: 'invalid'};
  const tariff = match[2] === 'b' ? 'basic' : 'premium';
  const cents = Number(match[3]);
  const rawProducts = payload.products;
  const products = Array.isArray(rawProducts) ? rawProducts : rawProducts && typeof rawProducts === 'object' ? Object.values(rawProducts) : [];
  if (!Number.isSafeInteger(cents) || products.length !== 1 ||
      String(products[0]?.name ?? '') !== PRODUCTS[tariff].name ||
      priceCents(products[0]?.price) !== cents ||
      String(products[0]?.quantity ?? '') !== '1' ||
      priceCents(payload.sum) !== cents) return {kind: 'invalid'};
  return {kind: 'site', tariff};
}
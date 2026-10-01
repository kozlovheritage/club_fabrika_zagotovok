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

// Active phase: presales. Later phase changes must also update the sales site's displayed prices.
const CURRENT_PRICES = {premium: 6790, basic: 5990};
const COLLECTION_DISCOUNTS = {
  premium: [1100, 1400],
  basic: [1000, 1100]
};
const FIXED_PRICES = {
  CLUBB3: {premium: 5990, basic: 5190},
  FABRIKA1R: {premium: 3400, basic: 2700},
  FABRIKA1B: {premium: 4500, basic: 3500},
  FABRIKA2PR: {premium: 1690, basic: 1490},
  FABRIKAB2P: {premium: 2390, basic: 1490}
};

export function quotePrice(tariff, promoInput = '') {
  if (!PRODUCTS[tariff]) throw new Error('Неизвестный тариф');
  if (typeof promoInput !== 'string' || promoInput.length > 100) throw new Error('Некорректный промокод');
  const codes = promoInput.trim().toUpperCase().split(/[\s,;]+/u).filter(Boolean);
  if (codes.length > 2) throw new Error('Можно применить не более двух кодов SKIDKA1C');
  const basePriceRub = CURRENT_PRICES[tariff];
  let priceRub = basePriceRub;
  if (codes.length) {
    if (codes.every(code => code === 'SKIDKA1C')) {
      priceRub -= COLLECTION_DISCOUNTS[tariff][codes.length - 1];
    } else if (codes.length === 1 && FIXED_PRICES[codes[0]]) {
      priceRub = FIXED_PRICES[codes[0]][tariff];
    } else {
      throw new Error(codes.some(code => !FIXED_PRICES[code] && code !== 'SKIDKA1C')
        ? 'Промокод не найден' : 'Эти промокоды нельзя суммировать');
    }
  }
  return {basePriceRub, priceRub, discountRub: basePriceRub - priceRub, codes};
}

function orderSignature(prefix, key) {
  const version = prefix.startsWith('fz4-') ? 'v4' : prefix.startsWith('fz3-') ? 'v3' : 'v2';
  return crypto.createHmac('sha256', key).update(`club-checkout-${version}:` + prefix).digest('hex').slice(0, 24);
}

function normalizedEmail(value) {
  const email = String(value ?? '').trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function normalizeBuyerName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim().replace(/\s+/gu, ' ');
  return name.length <= 120 &&
    /^[\p{L}][\p{L}\p{M}'’\-]*(?: [\p{L}][\p{L}\p{M}'’\-]*)+$/u.test(name) ? name : null;
}

function emailTag(email, key) {
  return crypto.createHmac('sha256', key).update('club-checkout-email:' + email).digest('hex').slice(0, 16);
}

export function premiumPasswordForOrder(orderId, key) {
  if (!/^fz[34]-p-/.test(orderId) || !key) return null;
  return 'Fz-' + crypto.createHmac('sha256', key)
    .update('club-premium-password:' + orderId).digest('base64url').slice(0, 18);
}

export function createCheckout(tariff, key, env = process.env, buyerEmail, promoInput = '', buyerName) {
  const product = PRODUCTS[tariff];
  const cents = product && quotePrice(tariff, promoInput).priceRub * 100;
  if (!cents || !key) return null;
  const email = buyerEmail === undefined ? null : normalizedEmail(buyerEmail);
  if (buyerEmail !== undefined && !email) return null;
  const name = buyerName === undefined ? null : normalizeBuyerName(buyerName);
  if (buyerName !== undefined && !name) return null;
  const prefix = email
    ? `fz${name ? '4' : '3'}-${product.code}-${cents}-${emailTag(email, key)}-${crypto.randomBytes(12).toString('hex')}`
    : `fz2-${product.code}-${cents}-${crypto.randomBytes(12).toString('hex')}`;
  const checkout = {
    order_id: `${prefix}-${orderSignature(prefix, key)}`,
    currency: 'rub',
    products: [{name: product.name, price: (cents / 100).toFixed(2), quantity: 1, type: 'service'}]
  };
  if (email) checkout.customer_email = email;
  if (name) checkout.customer_name = name;
  return checkout;
}

export function identifyCheckout(payload, key) {
  // Prodamus calls its own payment ID "order_id"; the merchant's ID is "order_num".
  const orderId = String(payload.order_num || payload.order_id || '');
  if (!orderId.startsWith('fz')) return {kind: 'external'};
  const v4 = /^(fz4-([bp])-([1-9]\d{2,8})-([0-9a-f]{16})-[0-9a-f]{24})-([0-9a-f]{24})$/.exec(orderId);
  const v3 = !v4 && /^(fz3-([bp])-([1-9]\d{2,8})-([0-9a-f]{16})-[0-9a-f]{24})-([0-9a-f]{24})$/.exec(orderId);
  const v2 = !v4 && !v3 && /^(fz2-([bp])-([1-9]\d{2,8})-[0-9a-f]{24})-([0-9a-f]{24})$/.exec(orderId);
  const match = v4 || v3 || v2;
  if (!match || !key) return {kind: 'invalid'};
  const expected = orderSignature(match[1], key);
  const signature = (v4 || v3) ? match[5] : match[4];
  if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return {kind: 'invalid'};
  const email = (v4 || v3) && normalizedEmail(payload.customer_email);
  if ((v4 || v3) && (!email || emailTag(email, key) !== match[4])) return {kind: 'invalid'};
  const tariff = match[2] === 'b' ? 'basic' : 'premium';
  const cents = Number(match[3]);
  const rawProducts = payload.products;
  const products = Array.isArray(rawProducts) ? rawProducts : rawProducts && typeof rawProducts === 'object' ? Object.values(rawProducts) : [];
  if (!Number.isSafeInteger(cents) || products.length !== 1 ||
      String(products[0]?.name ?? '') !== PRODUCTS[tariff].name ||
      priceCents(products[0]?.price) !== cents ||
      String(products[0]?.quantity ?? '') !== '1' ||
      priceCents(payload.sum) !== cents) return {kind: 'invalid'};
  return v4 ? {kind: 'site', tariff, orderId, email, requiresSavedName: true} :
    v3 ? {kind: 'site', tariff, orderId, email} : {kind: 'site', tariff};
}
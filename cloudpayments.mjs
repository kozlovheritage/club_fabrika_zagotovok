import crypto from 'node:crypto';

export class CloudPaymentsError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}

export function readCloudConfig(env = process.env) {
  const mode = env.CLOUDPAYMENTS_MODE || 'test';
  if (!['test', 'live'].includes(mode)) throw new Error('Invalid CloudPayments mode');
  const config = {
    enabled: env.CLOUDPAYMENTS_ENABLED === 'true',
    publicId: env.CLOUDPAYMENTS_PUBLIC_ID || '',
    secret: env.CLOUDPAYMENTS_API_SECRET || '',
    test: mode === 'test',
    terminalConfirmed: env.CLOUDPAYMENTS_TERMINAL_MODE_CONFIRMED === 'true',
    receiptApproved: env.CLOUDPAYMENTS_RECEIPT_APPROVED === 'true',
    receiptTemplate: env.CLOUDPAYMENTS_RECEIPT_TEMPLATE_JSON || ''
  };
  return config;
}

export function cents(value) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value))) return null;
  const [whole, fraction = ''] = String(value).split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(result) && result > 0 ? result : null;
}

export function validPaymentUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'orders.cloudpayments.ru' &&
      !url.port && !url.username && !url.password && !url.hash && !url.search &&
      /^\/d\/[a-zA-Z0-9_-]+$/.test(url.pathname);
  } catch { return false; }
}

// Per the official API: Content-HMAC signs URL-encoded/original body,
// X-Content-HMAC signs URL-decoded values. We verify ORIGINAL bytes with Content-HMAC.
export function validWebhookHmac(raw, received, secret) {
  if (!Buffer.isBuffer(raw) || !secret || !/^[A-Za-z0-9+/]{43}=$/.test(received || '')) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest();
  const supplied = Buffer.from(received, 'base64');
  return supplied.length === expected.length && crypto.timingSafeEqual(expected, supplied);
}

export function parseWebhook(raw, contentType) {
  if (contentType.startsWith('application/json')) {
    const value = JSON.parse(raw.toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid notification');
    return value;
  }
  if (!contentType.startsWith('application/x-www-form-urlencoded')) throw new Error('Unsupported notification');
  const entries = new URLSearchParams(raw.toString('utf8'));
  const result = Object.create(null);
  for (const [key, value] of entries) {
    if (Object.hasOwn(result, key)) throw new Error('Duplicate notification field');
    result[key] = value;
  }
  return result;
}

export function validateNotification(payload, order, config) {
  if (!order || payload.InvoiceId !== order.order_id) return {code: 10};
  if (payload.AccountId !== order.order_id) return {code: 11};
  if (cents(payload.Amount) !== Number(order.amount_cents)) return {code: 12};
  if (payload.Currency !== 'RUB') return {code: 13};
  const test = [true, 1, '1'].includes(payload.TestMode);
  const live = [false, 0, '0'].includes(payload.TestMode);
  if ((!test && !live) || test !== config.test) return {code: 10};
  if ((typeof payload.TransactionId === 'number' && !Number.isSafeInteger(payload.TransactionId)) ||
      !/^[1-9]\d{0,24}$/.test(String(payload.TransactionId))) return {code: 10};
  return {code: 0, transactionId: String(payload.TransactionId)};
}

// No assumptions about VAT, taxation system, receipt provider or legal classification.
// The complete JsonData template must first be approved by the merchant/provider.
// Whole-value placeholders preserve numeric amounts and safely insert strings.
export function receiptInstructions(checkout, config) {
  if (!config.receiptApproved || !config.receiptTemplate)
    throw new CloudPaymentsError('Формирование чеков CloudPayments ещё не согласовано');
  let template;
  try { template = JSON.parse(config.receiptTemplate); }
  catch { throw new CloudPaymentsError('Настройки чека CloudPayments некорректны'); }
  if (!template || Array.isArray(template) || typeof template !== 'object' ||
      !template.cloudpayments || typeof template.cloudpayments !== 'object' ||
      Array.isArray(template.cloudpayments) || !Object.keys(template.cloudpayments).length)
    throw new CloudPaymentsError('Инструкции чека CloudPayments не настроены');
  const values = {
    '$amount': cents(checkout.products[0].price) / 100,
    '$email': checkout.customer_email,
    '$product': checkout.products[0].name
  };
  const replace = value => {
    if (typeof value === 'string' && Object.hasOwn(values, value)) return values[value];
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, replace(child)]));
    return value;
  };
  return replace(template);
}

export async function createPaymentLink(checkout, siteUrl, config, fetcher = fetch) {
  if (!config.enabled || !config.publicId || !config.secret)
    throw new CloudPaymentsError('CloudPayments пока не подключён');
  if (!config.terminalConfirmed)
    throw new CloudPaymentsError('Режим платёжного терминала ещё не подтверждён');
  if (!/^https:\/\//.test(siteUrl||'')) throw new CloudPaymentsError('Адрес клуба не настроен');
  const amount = cents(checkout.products?.[0]?.price);
  if (!amount || checkout.products.length !== 1) throw new CloudPaymentsError('Некорректный заказ', 400);
  const data = {
    Amount: amount / 100, Currency: 'RUB',
    Description: checkout.products[0].name,
    InvoiceId: checkout.order_id, AccountId: checkout.order_id,
    Email: checkout.customer_email,
    RequireConfirmation: false, SendEmail: false, SendSms: false,
    CultureName: 'ru-RU',
    SuccessRedirectUrl: siteUrl + '/?paid=1',
    FailRedirectUrl: siteUrl + '/?login=1',
    JsonData: receiptInstructions(checkout, config)
  };
  let response;
  try {
    response = await fetcher('https://api.cloudpayments.ru/orders/create', {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Basic ' + Buffer.from(config.publicId + ':' + config.secret).toString('base64'),
        'X-Request-ID': 'club-cp-' + crypto.createHash('sha256').update(checkout.order_id).digest('hex')
      },
      body: JSON.stringify(data)
    });
  } catch { throw new CloudPaymentsError('Не удалось связаться с CloudPayments. Попробуйте позднее'); }
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.Success !== true || !validPaymentUrl(result.Model?.Url) ||
      cents(result.Model?.Amount) !== amount || result.Model?.Currency !== 'RUB')
    throw new CloudPaymentsError('CloudPayments не подтвердил создание оплаты');
  return result.Model.Url;
}

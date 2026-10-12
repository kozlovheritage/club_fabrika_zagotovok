export const MERCHANT_FORM = 'https://vera-mlgn.payform.ru/';

function fieldsFor(value, prefix = '') {
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      fieldsFor(item, prefix ? `${prefix}[${key}]` : key));
  }
  return [{name: prefix, value: String(value)}];
}

// Official Prodamus do=pay POST. The caller must restore the saved order first.
// This signs the payment request, not a payment notification or successful payment.
export function buildDirectPaymentForm(checkout, signPayload) {
  if (!checkout?.order_id || checkout.products?.length !== 1 ||
      !checkout.customer_email || typeof checkout.paid_content !== 'string' ||
      typeof signPayload !== 'function') throw new Error('Invalid saved checkout');
  const payload = {
    do: 'pay', sys: '', order_id: checkout.order_id, currency: checkout.currency,
    products: checkout.products, customer_email: checkout.customer_email,
    ...(checkout.customer_name ? {customer_name: checkout.customer_name} : {}),
    paid_content: checkout.paid_content
  };
  const signature = signPayload(payload);
  if (!/^[a-f0-9]{64}$/.test(signature)) throw new Error('Invalid payment signature');
  return {action: MERCHANT_FORM, method: 'POST', fields: fieldsFor({...payload, signature})};
}

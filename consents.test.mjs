import test from 'node:test';
import assert from 'node:assert/strict';
import { checkoutDocumentCatalog, validateCheckoutConsents, saveCheckoutConsentReceipt, renderArchivedLegalDocument } from './consents.mjs';

const catalog = checkoutDocumentCatalog('https://example.invalid');
const ids = Object.fromEntries(Object.entries(catalog.documents).map(([key, doc]) => [key, doc.id]));
const choice = () => ({ personalData: true, marketing: true, offer: true, documents: { ...ids } });

test('catalog includes all four immutable document references', () => {
  assert.deepEqual(Object.keys(catalog.documents), ['personalData', 'policy', 'marketing', 'offer']);
  for (const doc of Object.values(catalog.documents)) {
    assert.match(doc.id, /-[a-f0-9]{64}$/);
    assert.equal(doc.href, 'https://example.invalid/legal/documents/' + doc.id);
  }
});
test('missing, unchecked and incorrectly typed choices fail closed', () => {
  for (const value of [undefined, null, {}, [], { ...choice(), personalData: false },
    { ...choice(), offer: false }, { ...choice(), marketing: 'true' }, { ...choice(), personalData: 1 }]) {
    assert.throws(() => validateCheckoutConsents(value), { status: 400 });
  }
});
test('all four document versions are checked; stale versions require renewed confirmation', () => {
  for (const key of Object.keys(ids)) {
    assert.throws(() => validateCheckoutConsents({ ...choice(), documents: { ...ids, [key]: 'obsolete' } }), { status: 409 });
  }
});
test('explicit marketing refusal is recorded as false, never upgraded to consent', () => {
  assert.equal(validateCheckoutConsents({ ...choice(), marketing: false }).marketing, false);
});
test('timestamp and identity supplied by the browser are not trusted', () => {
  const parsed = validateCheckoutConsents({ ...choice(), recordedAt: '2000-01-01', email: 'other@example.invalid', ip: '0.0.0.0' });
  assert.equal(parsed.recordedAt, undefined);
  assert.equal(parsed.email, undefined);
  assert.equal(parsed.ip, undefined);
});
test('receipt stores canonical values with SQL parameters and a server-owned timestamp', async () => {
  const calls = [];
  await saveCheckoutConsentReceipt({ query: async (...args) => calls.push(args) }, {
    orderId: 'synthetic-order', email: 'audit@example.invalid', tariff: 'basic',
    origin: 'https://example.invalid', consents: validateCheckoutConsents({ ...choice(), marketing: false }),
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0][0], /^INSERT INTO club_checkout_consent_receipts/);
  assert.deepEqual(calls[0][1], ['synthetic-order', 'audit@example.invalid', 'basic', 'https://example.invalid', true, false, true,
    ids.personalData, ids.policy, ids.marketing, ids.offer]);
  assert.doesNotMatch(calls[0][0], /audit@example/);
});
test('legacy allowance is explicit and never fabricates a receipt', async () => {
  assert.equal(validateCheckoutConsents(undefined, { allowLegacy: true }), null);
  await saveCheckoutConsentReceipt({ query: () => assert.fail('must not fabricate legacy consent') }, { consents: null });
});
test('archived public document has a downloadable original and escaped metadata', () => {
  const html = renderArchivedLegalDocument({ title: '<script>', document_id: ids.offer, content_html: '<p>Original text</p>' });
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('/original.docx'));
  assert.ok(html.includes('<p>Original text</p>'));
});

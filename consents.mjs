import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';

const kinds = ['personal-data', 'policy', 'marketing', 'offer'];
const fields = { personalData: 'personal-data', policy: 'policy', marketing: 'marketing', offer: 'offer' };
const documents = await Promise.all(kinds.map(async kind => {
  const doc = JSON.parse(await readFile(new URL(`./legal/${kind}.json`, import.meta.url), 'utf8'));
  const original = Buffer.from(doc.originalBase64, 'base64');
  const originalHash = crypto.createHash('sha256').update(original).digest('hex');
  const version = crypto.createHash('sha256').update(original).update('\0').update(doc.contentHtml).digest('hex');
  if (doc.kind !== kind || originalHash !== doc.originalSha256 || doc.id !== kind + '-' + version) {
    throw new Error('Legal document integrity check failed');
  }
  return { ...doc, original };
}));
const activeByKind = new Map(documents.map(doc => [doc.kind, doc]));

export const CONSENT_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS club_legal_documents (
    document_id TEXT PRIMARY KEY, kind TEXT NOT NULL,
    title TEXT NOT NULL, source_url TEXT NOT NULL, original_sha256 TEXT NOT NULL,
    original_docx BYTEA NOT NULL, content_html TEXT NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS club_checkout_consent_receipts (
    order_id TEXT PRIMARY KEY, buyer_email TEXT NOT NULL, tariff TEXT NOT NULL,
    source_origin TEXT NOT NULL,
    personal_data_granted BOOLEAN NOT NULL CHECK (personal_data_granted),
    marketing_granted BOOLEAN NOT NULL,
    offer_accepted BOOLEAN NOT NULL CHECK (offer_accepted),
    personal_data_document_id TEXT NOT NULL REFERENCES club_legal_documents(document_id),
    policy_document_id TEXT NOT NULL REFERENCES club_legal_documents(document_id),
    marketing_document_id TEXT NOT NULL REFERENCES club_legal_documents(document_id),
    offer_document_id TEXT NOT NULL REFERENCES club_legal_documents(document_id),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  'CREATE INDEX IF NOT EXISTS club_consent_receipt_email ON club_checkout_consent_receipts (buyer_email,recorded_at)',
];

export async function archiveConsentDocuments(pool) {
  for (const doc of documents) {
    await pool.query(`INSERT INTO club_legal_documents
      (document_id,kind,title,source_url,original_sha256,original_docx,content_html)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (document_id) DO NOTHING`,
    [doc.id, doc.kind, doc.title, doc.sourceUrl, doc.originalSha256, doc.original, doc.contentHtml]);
  }
}

export function checkoutDocumentCatalog(publicUrl) {
  return { documents: Object.fromEntries(Object.entries(fields).map(([field, kind]) => {
    const doc = activeByKind.get(kind);
    return [field, { id: doc.id, title: doc.title, href: publicUrl + '/legal/documents/' + doc.id }];
  })) };
}

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
export function validateCheckoutConsents(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('Обновите страницу и подтвердите согласия перед оплатой.');
  }
  if (value.personalData !== true || value.offer !== true || typeof value.marketing !== 'boolean') {
    throw invalid('Подтвердите обработку персональных данных и условия оферты.');
  }
  if (!value.documents || typeof value.documents !== 'object' || Array.isArray(value.documents)) {
    throw invalid('Не удалось определить редакции документов. Обновите страницу.');
  }
  const ids = {};
  for (const [field, kind] of Object.entries(fields)) {
    const doc = activeByKind.get(kind);
    if (value.documents[field] !== doc.id) {
      throw invalid('Документы обновились. Откройте условия покупки заново и подтвердите их.', 409);
    }
    ids[field] = doc.id;
  }
  return { personalData: true, marketing: value.marketing, offer: true, documents: ids };
}

export async function saveCheckoutConsentReceipt(client, { orderId, email, tariff, origin, consents }) {
  if (!consents) throw new Error('Checkout consent receipt is required');
  await client.query(`INSERT INTO club_checkout_consent_receipts
    (order_id,buyer_email,tariff,source_origin,personal_data_granted,marketing_granted,offer_accepted,
     personal_data_document_id,policy_document_id,marketing_document_id,offer_document_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [orderId, email, tariff, origin, consents.personalData, consents.marketing, consents.offer,
    consents.documents.personalData, consents.documents.policy, consents.documents.marketing, consents.documents.offer]);
}

const escape = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function renderArchivedLegalDocument(doc) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(doc.title)}</title><style>
body{margin:0;background:#faf7f2;color:#302d2b;font:16px/1.65 Arial,sans-serif}
main{max-width:1100px;margin:auto;padding:28px 24px}p{margin:12px 0}
.meta{font-size:13px;color:#666;border-bottom:1px solid #ddd;padding-bottom:16px;overflow-wrap:anywhere}
a{color:#9b4964}.table-scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:14px}
th,td{border:1px solid #ccc;padding:10px;min-width:140px;text-align:left;vertical-align:top}th{background:#f1e8e4}
</style></head><body><main><div class="meta"><strong>${escape(doc.title)}</strong><br>
Неизменяемая редакция документа · ${escape(doc.document_id)}<br>
<a href="/legal/documents/${encodeURIComponent(doc.document_id)}/original.docx" download>Скачать оригинал DOCX</a>
</div>${doc.content_html}</main></body></html>`;
}

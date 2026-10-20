// Fixed existing private PDF bucket. Never log URLs: GET signatures are bearer links.
import {createHash, createHmac} from 'node:crypto';
const bucket = 'club-fabrika-pdf', region = 'ru-6';
const host = `${bucket}.s3.${region}.storage.selcloud.ru`;
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const hash = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
export function signObject(key, {method = 'GET', uploader = false, now = new Date()} = {}) {
  if (!/^(pdf\/[a-f0-9]{32}\.pdf|search\/pdf-index-[a-f0-9]{64}\.json)$/.test(key)) throw Error('INVALID_STORAGE_KEY');
  if (!['GET', 'PUT'].includes(method) || (method === 'PUT' && !uploader)) throw Error('INVALID_STORAGE_OPERATION');
  const access = uploader ? process.env.SELECTEL_S3_ACCESS_KEY_ID : process.env.SELECTEL_PDF_ACCESS_KEY_ID;
  const secret = uploader ? process.env.SELECTEL_S3_SECRET_ACCESS_KEY : process.env.SELECTEL_PDF_SECRET_ACCESS_KEY;
  if (!access || !secret) throw Error('PRIVATE_STORAGE_NOT_CONFIGURED');
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = timestamp.slice(0, 8);
  const scope = `${day}/${region}/s3/aws4_request`, path = '/' + key;
  const params = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': `${access}/${scope}`,
    'X-Amz-Date': timestamp, 'X-Amz-Expires': '300', 'X-Amz-SignedHeaders': 'host'
  };
  const query = Object.entries(params).map(([k, v]) => [encode(k), encode(v)])
    .sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k, v]) => `${k}=${v}`).join('&');
  const request = `${method}\n${path}\n${query}\nhost:${host}\n\nhost\nUNSIGNED-PAYLOAD`;
  const signingKey = hmac(hmac(hmac(hmac('AWS4' + secret, day), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(`AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${hash(request)}`).digest('hex');
  return `https://${host}${path}?${query}&X-Amz-Signature=${signature}`;
}

export async function readPrivateIndex(manifest) {
  const response = await fetch(signObject(manifest.objectKey), {signal: AbortSignal.timeout(15000)});
  if (!response.ok) throw Error('PRIVATE_INDEX_HTTP_' + response.status);
  const chunks = []; let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4_000_000) throw Error('PRIVATE_INDEX_TOO_LARGE');
      chunks.push(chunk);
    }
  } finally { if (size > 4_000_000) await response.body?.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks);
  if (hash(bytes) !== manifest.sha256 || bytes.length !== manifest.bytes) throw Error('PRIVATE_INDEX_INTEGRITY');
  return JSON.parse(bytes.toString('utf8'));
}

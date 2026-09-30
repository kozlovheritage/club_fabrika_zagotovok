import assert from 'node:assert/strict';
import test from 'node:test';
import {buildPremiumPaidContent, PREMIUM_TELEGRAM_URL, sendCredentialsEmail} from './email.mjs';

test('Prodamus premium paid content includes platform credentials and the direct Telegram invite', () => {
  const content = buildPremiumPaidContent('https://club.example.org', 'customer@example.org', 'example-password');
  assert.match(content, /Личный кабинет: https:\/\/club\.example\.org\/\?login=1/);
  assert.match(content, /Email для входа: customer@example\.org/);
  assert.match(content, /Пароль: example-password/);
  assert.ok(content.includes('Telegram-канал для участников расширенного тарифа: ' + PREMIUM_TELEGRAM_URL));
});

test('NotiSend accepts one personalized email from a plain sender address', async () => {
  const originalFetch = globalThis.fetch;
  const originals = {
    AUTH_EMAIL_PROVIDER: process.env.AUTH_EMAIL_PROVIDER,
    NOTISEND_API_KEY: process.env.NOTISEND_API_KEY,
    AUTH_FROM_EMAIL: process.env.AUTH_FROM_EMAIL
  };
  process.env.AUTH_EMAIL_PROVIDER = 'notisend';
  process.env.NOTISEND_API_KEY = 'test-key';
  process.env.AUTH_FROM_EMAIL = 'care@example.org';
  let requests = 0;
  globalThis.fetch = async (url, options) => {
    requests++;
    assert.equal(url, 'https://api.notisend.ru/v1/email/messages');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(options.body);
    assert.equal(body.from_email, 'care@example.org');
    assert.equal(body.to, 'customer@example.org');
    assert.equal(body.payment, 'subscriber_priority');
    assert.match(body.text, /Пароль: example-password/);
    assert.match(body.html, /customer@example\.org/);
    assert.ok(body.text.includes(PREMIUM_TELEGRAM_URL));
    assert.ok(body.html.includes('href="' + PREMIUM_TELEGRAM_URL + '"'));
    return new Response(JSON.stringify({id: 1, status: 'queued'}), {status: 201});
  };
  try {
    await sendCredentialsEmail('customer@example.org', 'example-password', 'https://example.org/club');
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('NotiSend rejects an unconfigured sender before making a request', async () => {
  const originalProvider = process.env.AUTH_EMAIL_PROVIDER;
  const originalSender = process.env.AUTH_FROM_EMAIL;
  process.env.AUTH_EMAIL_PROVIDER = 'notisend';
  process.env.AUTH_FROM_EMAIL = 'Name <care@example.org>';
  try {
    await assert.rejects(
      sendCredentialsEmail('customer@example.org', 'example-password', 'https://example.org'),
      /Email provider is not configured/
    );
  } finally {
    if (originalProvider === undefined) delete process.env.AUTH_EMAIL_PROVIDER;
    else process.env.AUTH_EMAIL_PROVIDER = originalProvider;
    if (originalSender === undefined) delete process.env.AUTH_FROM_EMAIL;
    else process.env.AUTH_FROM_EMAIL = originalSender;
  }
});
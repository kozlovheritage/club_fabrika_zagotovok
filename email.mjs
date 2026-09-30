const subject = 'Доступ в клуб «Фабрика заготовок»';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[char]);
}

export async function sendCredentialsEmail(email, password, siteUrl) {
  const provider = process.env.AUTH_EMAIL_PROVIDER;
  const from = process.env.AUTH_FROM_EMAIL;
  const text = 'Ваш доступ в клуб открыт. Сайт: ' + siteUrl +
    '\nEmail: ' + email + '\nПароль: ' + password +
    '\n\nСохраните это письмо. Пароль постоянный и не меняется при повторной оплате.';
  const html = '<h2>Доступ в клуб «Фабрика заготовок» открыт</h2>' +
    '<p><a href="' + escapeHtml(siteUrl) + '">Открыть сайт клуба</a></p>' +
    '<p><b>Email:</b> ' + escapeHtml(email) +
    '<br><b>Пароль:</b> ' + escapeHtml(password) + '</p>' +
    '<p>Сохраните это письмо. Пароль постоянный и не меняется при повторной оплате.</p>';

  let url;
  let token;
  let body;
  if (provider === 'resend' && process.env.RESEND_API_KEY && from) {
    url = 'https://api.resend.com/emails';
    token = process.env.RESEND_API_KEY;
    body = {from, to: [email], subject, text, html};
  } else if (provider === 'notisend' && process.env.NOTISEND_API_KEY &&
             /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from || '')) {
    url = 'https://api.notisend.ru/v1/email/messages';
    token = process.env.NOTISEND_API_KEY;
    body = {
      from_email: from,
      from_name: process.env.AUTH_FROM_NAME || 'Служба заботы «Фабрики заготовок»',
      to: email,
      subject,
      text,
      html,
      payment: 'subscriber_priority'
    };
  } else {
    throw new Error('Email provider is not configured');
  }

  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error('Email provider returned ' + response.status);
  if (provider === 'notisend') {
    const result = await response.json().catch(() => null);
    if (!result?.id || !['queued', 'sent', 'delivered'].includes(result.status)) {
      throw new Error('NotiSend did not accept the email for delivery');
    }
  }
}
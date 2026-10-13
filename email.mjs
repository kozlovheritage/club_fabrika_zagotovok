const subject = 'Доступ в клуб «Фабрика заготовок»';
export const PREMIUM_TELEGRAM_URL = 'https://t.me/+Pc_CVDo-JtU1ODYy';

export function buildPremiumPaidContent(siteUrl, email, password) {
  return 'Расширенный тариф клуба «Фабрика заготовок». Личный кабинет: ' + siteUrl +
    '/?login=1\nEmail для входа: ' + email +
    '\nПароль: ' + password +
    '\nTelegram-канал для участников расширенного тарифа: ' + PREMIUM_TELEGRAM_URL +
    '\nСохраните это письмо: данные для входа действуют бессрочно.';
}

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
    '\nTelegram-канал для участников расширенного тарифа: ' + PREMIUM_TELEGRAM_URL +
    '\n\nСохраните это письмо. Пароль постоянный и не меняется при повторной оплате.';
  const html = '<h2>Доступ в клуб «Фабрика заготовок» открыт</h2>' +
    '<p><a href="' + escapeHtml(siteUrl) + '">Открыть сайт клуба</a></p>' +
    '<p><b>Email:</b> ' + escapeHtml(email) +
    '<br><b>Пароль:</b> ' + escapeHtml(password) + '</p>' +
    '<p>Telegram-канал для участников расширенного тарифа: <a href="' +
      escapeHtml(PREMIUM_TELEGRAM_URL) + '">' + escapeHtml(PREMIUM_TELEGRAM_URL) + '</a></p>' +
    '<p>Сохраните это письмо. Пароль постоянный и не меняется при повторной оплате.</p>';

  return sendAccessMessage(email,text,html);
}

export async function sendBasicAccessEmail(email, accessUrl) {
  const text='Базовый тариф клуба «Фабрика заготовок». Ваш доступ открыт.\nВступить в закрытый Telegram-клуб: '+accessUrl;
  const html='<h2>Доступ в клуб открыт</h2><p>Базовый тариф</p><p><a href="'+escapeHtml(accessUrl)+'">Вступить в Telegram-клуб</a></p>';
  return sendAccessMessage(email,text,html);
}

export async function sendAdminMailAlert(email,siteUrl,{count,recovery}) {
  const text=(recovery?'Проблемные письма обработаны.':'Требуют проверки заказов: '+count+'.')+
    '\nОткройте закрытый раздел: '+siteUrl+'/admin\nВойдите в свой личный кабинет.';
  return sendAccessMessage(email,text,'<p>'+escapeHtml(text)+'</p>','Контроль писем клуба');
}

async function sendAccessMessage(email,text,html,messageSubject=subject) {
  const provider=process.env.AUTH_EMAIL_PROVIDER;
  const from=process.env.AUTH_FROM_EMAIL;
  let url;
  let token;
  let body;
  if (provider === 'resend' && process.env.RESEND_API_KEY && from) {
    url = 'https://api.resend.com/emails';
    token = process.env.RESEND_API_KEY;
    body = {from, to: [email], subject:messageSubject, text, html};
  } else if (provider === 'notisend' && process.env.NOTISEND_API_KEY &&
             /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(from || '')) {
    url = 'https://api.notisend.ru/v1/email/messages';
    token = process.env.NOTISEND_API_KEY;
    body = {
      from_email: from,
      from_name: process.env.AUTH_FROM_NAME || 'Служба заботы «Фабрики заготовок»',
      to: email,
      subject:messageSubject,
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
  if (!response.ok) {
    const error=new Error('Email provider request failed');
    error.status=response.status;
    error.permanent=[400,401,403,404,422].includes(response.status);
    throw error;
  }
  const result=await response.json().catch(()=>null);
  if(!result?.id||!/^[A-Za-z0-9_-]{1,100}$/.test(String(result.id)))
    throw new Error('Email provider receipt missing');
  if (provider === 'notisend') {
    if(!['queued','sent','delivered','skipped','soft_bounced','hard_bounced'].includes(result.status))
      throw new Error('Email provider status invalid');
  }
  return {provider,messageId:String(result.id),status:provider==='notisend'?result.status:'queued',recipient:email};
}
import crypto from 'node:crypto';

const invisible = /[\u200B-\u200D\u2060\uFEFF]/g;
const typographicDash = /[\u2010-\u2014\u2212\uFE63\uFF0D]/g;
const passwordTag = value => crypto.createHash('sha256')
  .update('club-order-password:' + value,'utf8').digest('hex');

export function emailDiagnosticKey(email,key) {
  return crypto.createHmac('sha256',key).update('club-login-diagnostic:' + email).digest('hex').slice(0,16);
}

// Return shape information only. Never return credentials, their tags, or an email.
export function describeRejectedLogin({email,password,activePasswordTags=[]}) {
  const tags = activePasswordTags.filter(tag => /^[0-9a-f]{64}$/.test(tag || ''));
  const variants = [
    ['edge_whitespace',password.trim()],
    ['invisible_formatting',password.replace(invisible,'')],
    ['typographic_dash',password.replace(typographicDash,'-')],
    ['paste_formatting',password.trim().replace(invisible,'').replace(typographicDash,'-')]
  ];
  let normalizationMatch = null;
  for (const [kind,value] of variants) {
    if (value === password) continue;
    const candidate = Buffer.from(passwordTag(value),'hex');
    if (tags.some(tag => crypto.timingSafeEqual(candidate,Buffer.from(tag,'hex')))) {
      normalizationMatch = kind;
      break;
    }
  }
  return {
    emailHasNonAscii:/[^\x00-\x7F]/.test(email),
    emailHasInvisibleFormatting:/[\u200B-\u200D\u2060\uFEFF]/.test(email),
    passwordLength:password.length,
    passwordHasEdgeWhitespace:password.trim() !== password,
    passwordHasWhitespace:/\s/u.test(password),
    passwordHasInvisibleFormatting:/[\u200B-\u200D\u2060\uFEFF]/.test(password),
    passwordHasNonAscii:/[^\x00-\x7F]/.test(password),
    normalizationMatch
  };
}

export function rejectedLoginHint(diagnostic) {
  if (diagnostic.normalizationMatch === 'edge_whitespace') {
    return 'Вставленный пароль совпадает после удаления пробелов по краям. Скопируйте только пароль, без пробелов и переноса строки.';
  }
  if (diagnostic.normalizationMatch) {
    return 'При вставке пароль получил невидимые символы или другой знак дефиса. Скопируйте только пароль либо введите его вручную.';
  }
  if (diagnostic.emailHasInvisibleFormatting || diagnostic.emailHasNonAscii) {
    return 'Проверьте email: в нём есть невидимые или нелатинские символы.';
  }
  return 'Нажмите «Показать пароль» и проверьте, что браузер не подставил другие данные.';
}
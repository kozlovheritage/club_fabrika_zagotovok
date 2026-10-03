import crypto from 'node:crypto';

const TTL=30*60*1000;
const idPattern=/^L-[0-9A-F]{16}$/;
const clientStages=new Set(['form_loaded','submit_clicked','form_invalid','form_submitted',
  'cabinet_dom_ready','cabinet_initialized','profile_loaded','profile_rejected','profile_network_error',
  'script_error','promise_error','cabinet_timeout','returned_to_login']);
const stages=new Set([...clientStages,'form_served','login_request_received','login_rejected',
  'auth_accepted','session_issued','cabinet_request_received','session_confirmed',
  'session_missing','login_server_error']);
const enums={
  page:['login','club'],field:['email','password','other'],
  errorKind:['SyntaxError','TypeError','ReferenceError','SecurityError','Error','other'],
  browser:['yandex','safari','chrome','firefox','other'],
  platform:['ios','android','windows','macos','linux','other']
};
export function createJourney(key,now=Date.now()){
  const incident='L-'+crypto.randomBytes(8).toString('hex').toUpperCase();
  const payload=incident+'.'+now;
  const signature=crypto.createHmac('sha256',key).update('club-login-journey:'+payload).digest('base64url');
  return {incident,token:payload+'.'+signature};
}
export function parseJourney(token,key,now=Date.now()){
  if(typeof token!=='string'||token.length>160)return null;
  const [incident,issued,signature,...extra]=token.split('.');
  if(extra.length||!idPattern.test(incident)||!/^\d{13}$/.test(issued)||!/^[\w-]{43}$/.test(signature||''))return null;
  const age=now-Number(issued);if(age<0||age>TTL)return null;
  const expected=crypto.createHmac('sha256',key).update('club-login-journey:'+incident+'.'+issued).digest('base64url');
  if(!crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return null;
  return {incident,token};
}
// Never copy arbitrary request fields, URLs, error messages, or input values.
export function stageMetadata(stage,input={},client=false){
  if(!(client?clientStages:stages).has(stage))return null;
  const result={stage,source:client?'browser':'server'};
  for(const [key,values] of Object.entries(enums))if(values.includes(input[key]))result[key]=input[key];
  for(const key of ['cookieEnabled','traceCookiePresent','sessionCookiePresent','formLogin','diagnosticStorageUnavailable'])
    if(typeof input[key]==='boolean')result[key]=input[key];
  for(const key of ['viewportWidth','viewportHeight'])
    if(Number.isInteger(input[key])&&input[key]>=100&&input[key]<=8192)result[key]=input[key];
  if(Number.isInteger(input.httpStatus)&&input.httpStatus>=100&&input.httpStatus<=599)result.httpStatus=input.httpStatus;
  if(!client&&/^[0-9a-f]{16}$/.test(input.emailKey||''))result.emailKey=input.emailKey;
  if(!client&&/^L-[0-9A-F]{8}$/.test(input.rejectionIncident||''))result.rejectionIncident=input.rejectionIncident;
  return result;
}
export function browserContext(userAgent=''){
  const ua=String(userAgent).slice(0,512);
  return {
    browser:/YaBrowser/i.test(ua)?'yandex':/Firefox|FxiOS/i.test(ua)?'firefox':
      /Chrome|CriOS/i.test(ua)?'chrome':/Safari/i.test(ua)?'safari':'other',
    platform:/iPhone|iPad|iPod/i.test(ua)?'ios':/Android/i.test(ua)?'android':
      /Windows/i.test(ua)?'windows':/Macintosh/i.test(ua)?'macos':/Linux/i.test(ua)?'linux':'other'
  };
}
export function journeyHtml(html,journey,page){
  if(!journey)return html;
  const script='<script src="/login-journey.js" data-token="'+journey.token+
    '" data-code="'+journey.incident+'" data-page="'+page+'"></script>';
  let result=html.replace('<head>','<head>\n'+script);
  const badge='<p id="loginJourneyCode" role="status" style="font:12px Arial,sans-serif;color:#555;padding:8px">'+
    'Код проверки входа: <span>'+journey.incident+'</span></p>';
  if(page==='login'){
    result=result.replace('<form method="post" action="/api/auth/login">',
      '<form method="post" action="/api/auth/login"><input type="hidden" name="_login_trace" value="'+journey.token+'">');
    result=result.replace('</form>','</form>'+badge);
  }else{
    result=result.replace('</body>',badge+'</body>');
  }
  return result;
}
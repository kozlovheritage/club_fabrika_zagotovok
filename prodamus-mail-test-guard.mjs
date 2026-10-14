// Test-only preload: child processes cannot contact external payment/mail/storage.
// Only synthetic NotiSend responses and loopback HTTP are allowed.
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(url,options={})=>{
  const target=new URL(String(url));
  if(target.hostname==='127.0.0.1'||target.hostname==='localhost')return nativeFetch(url,options);
  if(target.origin==='https://api.notisend.ru'&&process.env.NOTISEND_API_KEY==='synthetic-mail-key'){
    if(options.method==='POST')return new Response(JSON.stringify({id:'synthetic-'+crypto.randomUUID(),status:'queued'}),{status:201});
    return new Response(JSON.stringify({id:decodeURIComponent(target.pathname.split('/').at(-1)),status:'delivered'}));
  }
  throw new Error('Synthetic test blocked external request');
};

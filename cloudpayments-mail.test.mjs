import test from 'node:test';
import assert from 'node:assert/strict';
import {sendBasicAccessEmail} from './email.mjs';

test('basic tariff receives only the protected Telegram-access link, not platform credentials',async()=>{
  const keys=['AUTH_EMAIL_PROVIDER','AUTH_FROM_EMAIL','NOTISEND_API_KEY'];
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  const originalFetch=globalThis.fetch;
  process.env.AUTH_EMAIL_PROVIDER='notisend';
  process.env.AUTH_FROM_EMAIL='care@example.test';
  process.env.NOTISEND_API_KEY='synthetic-mail-key';
  let body;
  globalThis.fetch=async(url,options)=>{
    assert.equal(url,'https://api.notisend.ru/v1/email/messages');
    body=JSON.parse(options.body);
    return {ok:true,json:async()=>({id:'synthetic-message',status:'queued'})};
  };
  try{
    await sendBasicAccessEmail('buyer@example.test','https://club.example.test/access/basic/synthetic-order');
    assert.equal(body.to,'buyer@example.test');
    assert.match(body.text,/Базовый тариф/);
    assert.match(body.html,/access\/basic\/synthetic-order/);
    assert.doesNotMatch(body.text,/пароль|Пароль|Fz-/);
    assert.doesNotMatch(body.html,/пароль|Пароль|Fz-/);
  }finally{
    globalThis.fetch=originalFetch;
    for(const key of keys){
      if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];
    }
  }
});

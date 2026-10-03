import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {createJourney,parseJourney,stageMetadata,browserContext,journeyHtml} from './login-journey.mjs';

const key='isolated-test-key-not-a-real-credential';
test('journey signature, expiry and strict shape',()=>{
  const now=Date.now();const journey=createJourney(key,now);
  assert.deepEqual(parseJourney(journey.token,key,now+1000),journey);
  assert.equal(parseJourney(journey.token,key,now+1800001),null);
  assert.equal(parseJourney(journey.token,key,now-1),null);
  assert.equal(parseJourney(journey.token,key+'wrong',now),null);
  assert.equal(parseJourney(journey.token+'junk',key,now),null);
  assert.equal(parseJourney('L-1.hello.unsafe',key,now),null);
});
test('strict event allowlist never copies secrets or raw errors',()=>{
  const input={password:'private-value',email:'private@example.test',stack:'private-stack',
    url:'https://example.test/?password=private',token:'private-token',errorKind:'TypeError',
    page:'login',viewportWidth:390,httpStatus:200,emailKey:'0123456789abcdef'};
  assert.deepEqual(stageMetadata('script_error',input,true),
    {stage:'script_error',source:'browser',errorKind:'TypeError',page:'login',viewportWidth:390,httpStatus:200});
  assert.equal(stageMetadata('auth_accepted',input,true),null);
  assert.equal(stageMetadata('unknown',input),null);
});
test('browser context keeps no raw user agent',()=>{
  assert.deepEqual(browserContext('Mozilla iPhone YaBrowser/26 Safari/605'),{browser:'yandex',platform:'ios'});
  assert.deepEqual(browserContext('Mozilla iPad Safari/605'),{browser:'safari',platform:'ios'});
  assert.equal(JSON.stringify(browserContext('private@example.test')).includes('private'),false);
});
test('observer installed before member script, native form and code remain usable',()=>{
  const j=createJourney(key);
  const html='<head></head><body><form method="post" action="/api/auth/login"></form><a class="login-back"></a><script>main()</script></body>';
  const rendered=journeyHtml(html,j,'login');
  assert.ok(rendered.indexOf('login-journey.js')<rendered.indexOf('main()'));
  assert.ok(rendered.includes('method="post" action="/api/auth/login"'));
  assert.ok(rendered.includes('name="_login_trace"'));
  assert.ok(rendered.includes(j.incident));
  assert.equal(journeyHtml(html,null,'login'),html);
});
test('independent observer catches Safari-style syntax errors without retaining the message',async()=>{
  const source=await readFile(new URL('./login-journey.js',import.meta.url),'utf8');
  const events=[];const handlers={};
  const j=createJourney(key);
  const context={
    document:{currentScript:{getAttribute:k=>({'data-token':j.token,'data-code':j.incident,'data-page':'club'}[k])},
      addEventListener:(name,handler)=>{handlers[name]=handler;}},
    window:{addEventListener:(name,handler)=>{handlers[name]=handler;}},
    navigator:{sendBeacon:(_,blob)=>{events.push(JSON.parse(blob.value));return true;}},
    Blob:class{constructor(parts){this.value=parts.join('');}},
    sessionStorage:{getItem:()=>null},Date,JSON
  };
  vm.runInNewContext(source,context);
  handlers.error({message:'SyntaxError: invalid regexp with private-value'});
  assert.equal(events[0].stage,'script_error');assert.equal(events[0].errorKind,'SyntaxError');
  assert.ok(!JSON.stringify(events).includes('private-value'));
  assert.equal(source.includes('loginPassword'),false);
  assert.equal(source.includes('.value'),true); // Only the signed hidden diagnostic field.
});
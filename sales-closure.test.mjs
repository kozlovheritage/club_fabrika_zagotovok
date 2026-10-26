import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {rejectClosedSales} from './sales-closure.mjs';

for(const path of ['/session','/direct','/unknown']){
  test(`Closed checkout rejects ${path} before any payment action`,()=>{
    let nextCalled=false;
    const res={
      headers:{},set(k,v){this.headers[k]=v;return this;},
      status(v){this.statusCode=v;return this;},
      json(v){this.body=v;return this;}
    };
    rejectClosedSales({method:'POST',path},res,()=>{nextCalled=true;});
    assert.equal(res.statusCode,403);
    assert.equal(res.body.code,'SALES_CLOSED');
    assert.equal(res.headers['Cache-Control'],'no-store');
    assert.equal(nextCalled,false);
  });
}
test('CORS preflight is not blocked',()=>{
  let called=false;
  rejectClosedSales({method:'OPTIONS'},{},()=>{called=true;});
  assert.equal(called,true);
});
test('Guard is mounted before both checkout routes, not on payment webhooks',async()=>{
  const source=await readFile(new URL('./server.mjs',import.meta.url),'utf8');
  const guard=source.indexOf("app.use('/api/checkout',rejectClosedSales)");
  assert.ok(guard>0);
  for(const endpoint of ['session','direct']){
    assert.ok(source.indexOf(`app.post('/api/checkout/${endpoint}'`)>guard);
  }
  assert.equal((source.match(/rejectClosedSales\)/g)||[]).length,1);
});

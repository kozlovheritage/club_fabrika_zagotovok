import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import {createCloudService,mountCloudNotifications} from './cloudpayments-router.mjs';

test('real HTTP parser preserves encoded and JSON HMAC, acknowledges only validated payments',async t=>{
  const config={enabled:true,secret:'synthetic-http-signing-key',test:true};
  const order={order_id:'synthetic-order',amount_cents:100,test_mode:true,status:'pending'};
  let grants=0;
  const app=express();
  mountCloudNotifications(app,express,createCloudService(config,{
    getOrder:async id=>id===order.order_id?order:null,
    fulfill:async()=>{grants++;}
  }));
  app.use(express.json());
  app.use(express.urlencoded({extended:true}));
  app.post('/legacy', (req,res)=>res.json(req.body));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const data={InvoiceId:'synthetic-order',AccountId:'synthetic-order',Amount:'1.00',
    Currency:'RUB',TestMode:'1',TransactionId:'321',Status:'Completed',Email:'Ирина+test@example.test'};
  for(const [type,body] of [
    ['application/x-www-form-urlencoded',new URLSearchParams(data).toString()],
    ['application/json',JSON.stringify(data)]
  ]){
    const hmac=crypto.createHmac('sha256',config.secret).update(body).digest('base64');
    const response=await fetch(base+'/api/webhooks/cloudpayments/pay',{
      method:'POST',headers:{'Content-Type':type,'Content-HMAC':hmac},body
    });
    assert.equal(response.status,200);assert.deepEqual(await response.json(),{code:0});
  }
  assert.equal(grants,2); // Durable store, tested separately, owns deduplication.
  const denied=await fetch(base+'/api/webhooks/cloudpayments/pay',{
    method:'POST',headers:{'Content-Type':'application/json','Content-HMAC':'invalid'},body:JSON.stringify(data)
  });
  assert.equal(denied.status,401);assert.equal(grants,2);
  const legacy=await fetch(base+'/legacy',{
    method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'a=1&b=2'
  });
  assert.deepEqual(await legacy.json(),{a:'1',b:'2'});
});

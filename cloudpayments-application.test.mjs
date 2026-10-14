import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import pg from 'pg';
import {premiumPasswordForOrder} from './checkout.mjs';
import {createAdminStore} from './admin-store.mjs';

const dsn=process.env.CLOUDPAYMENTS_TEST_DB_URL;
const key='synthetic-only-checkout-signing-key-32-characters';
const secret='synthetic-only-notification-secret';
async function boot(t,cloud=false){
  const reservation=net.createServer().listen(0,'127.0.0.1');
  await new Promise(resolve=>reservation.once('listening',resolve));
  const port=reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
  // Whitelisted environment: NO inherited payment, email, storage or DB secrets.
  const child=spawn(process.execPath,['server.mjs'],{
    cwd:new URL('.',import.meta.url),
    env:{PATH:process.env.PATH,PORT:String(port),NODE_ENV:'test',PGSSL:'false',
      DATABASE_URL:dsn,PUBLIC_URL:'https://club.example.test',
      AUTH_CREDENTIAL_KEY:key,SALES_ORIGINS:'https://sales.example.test',
      BASIC_CHECKOUT_ENABLED:'true',BASIC_ACCESS_URL:'https://t.me/+synthetic-test',
      CHECKOUT_PROVIDER:cloud?'cloudpayments':'prodamus',
      CLOUDPAYMENTS_ENABLED:cloud?'true':'false',CLOUDPAYMENTS_MODE:'live',
      CLOUDPAYMENTS_PUBLIC_ID:'synthetic-only',CLOUDPAYMENTS_API_SECRET:secret,
      CLOUDPAYMENTS_TERMINAL_MODE_CONFIRMED:'false',CLOUDPAYMENTS_RECEIPT_APPROVED:'false'}
  });
  t.after(async()=>{if(child.exitCode===null){const exit=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exit;}});
  await new Promise((resolve,reject)=>{
    let output='';
    const timer=setTimeout(()=>reject(new Error('Synthetic app startup timed out: '+output)),10000);
    child.stderr.on('data',data=>{output+=data.toString();});
    child.stdout.on('data',data=>{
      if(data.toString().includes('Club server listening')){clearTimeout(timer);resolve();}
    });
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('Synthetic app exited: '+output));});
  });
  return 'http://127.0.0.1:'+port;
}
const post=(base,path,body,headers={})=>fetch(base+path,{
  method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)
});
async function buyer(base,tariff,email,paymentProvider){
  const docs=await (await fetch(base+'/api/legal/checkout-documents')).json();
  return {tariff,email,buyerName:'Тестовая Участница',promo:'',
    ...(paymentProvider?{paymentProvider}:{}),
    consents:{personalData:true,marketing:false,offer:true,
      documents:Object.fromEntries(Object.entries(docs.documents).map(([name,doc])=>[name,doc.id]))}};
}
test('whole app: manual selection preserves Prodamus and in-flight Cloud callbacks',
  {skip:!dsn},async t=>{
    const url=new URL(dsn);
    assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/club_cloudpayments_test');
    const pool=new pg.Pool({connectionString:dsn});t.after(()=>pool.end());
    const standby=await boot(t);
    const legacy=await post(standby,'/api/checkout/session',await buyer(standby,'premium','legacy@example.test'),
      {Origin:'https://sales.example.test'});
    assert.equal(legacy.status,200);
    const legacyData=await legacy.json();
    assert.equal(legacyData.provider,'prodamus');
    assert.ok(legacyData.products);assert.match(legacyData.paid_content,/Личный кабинет/);
    assert.equal((await pool.query("SELECT to_regclass('public.club_cp_orders') AS table_name")).rows[0].table_name,null);
    const active=await boot(t,true);
    const oldPage=await post(active,'/api/checkout/session',await buyer(active,'premium','oldpage@example.test','cloudpayments'),
      {Origin:'https://sales.example.test'});
    assert.equal(oldPage.status,200);
    assert.equal((await oldPage.json()).provider,'prodamus'); // Browser cannot switch it.
    const selector=createAdminStore(pool);
    assert.equal(await selector.activeCheckoutProvider(),'prodamus'); // Restart does not switch.
    await selector.setCheckoutProvider('cloudpayments','prodamus');
    const oldDirect=await post(active,'/api/checkout/direct',{}, {Origin:'https://sales.example.test'});
    assert.equal(oldDirect.status,400); // No blanket disabling of existing Prodamus orders.
    for(const [tariff,email,txn] of [['premium','premium@example.test','98765431'],['basic','basic@example.test','98765432']]){
      const pending=await post(active,'/api/checkout/session',await buyer(active,tariff,email,'cloudpayments'),
        {Origin:'https://sales.example.test'});
      assert.equal(pending.status,503); // No approved terminal/receipt => NO external API call.
      const order=(await pool.query('SELECT * FROM club_cp_orders WHERE buyer_email=$1',[email])).rows[0];
      assert.ok(order);
      await selector.setCheckoutProvider('prodamus','cloudpayments');
      const data={InvoiceId:order.order_id,AccountId:order.order_id,Amount:Number(order.amount_cents)/100,
        Currency:'RUB',TestMode:0,TransactionId:txn,Status:'Completed',Email:'untrusted@example.test'};
      const raw=JSON.stringify(data);
      const hmac=crypto.createHmac('sha256',secret).update(raw).digest('base64');
      for(let i=0;i<2;i++){
        const accepted=await post(active,'/api/webhooks/cloudpayments/pay',data,{'Content-HMAC':hmac});
        assert.equal(accepted.status,200);assert.deepEqual(await accepted.json(),{code:0});
      }
      const mail=(await pool.query('SELECT count(*)::integer AS n FROM club_cp_access_mail WHERE order_id=$1',[order.order_id])).rows[0];
      assert.equal(mail.n,1);
      if(tariff==='premium'){
        const login=await post(active,'/api/auth/login',{email,password:premiumPasswordForOrder(order.order_id,key)});
        assert.equal(login.status,200);assert.equal((await login.json()).email,email);
      }else{
        assert.equal((await pool.query('SELECT count(*)::integer AS n FROM club_users WHERE login_email=$1',[email])).rows[0].n,0);
        const access=await fetch(active+'/access/basic/'+order.order_id,{redirect:'manual'});
        assert.equal(access.status,302);assert.equal(access.headers.get('location'),'https://t.me/+synthetic-test');
      }
      await selector.setCheckoutProvider('cloudpayments','prodamus');
    }
    await selector.setCheckoutProvider('prodamus','cloudpayments');
  });

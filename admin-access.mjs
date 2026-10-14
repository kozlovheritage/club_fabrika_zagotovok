import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {SupportError} from './admin-store.mjs';

export function csrfForSession(req,key){
  const match=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('club_session='));
  return crypto.createHmac('sha256',key).update('club-admin-csrf:'+String(match||'')).digest('hex');
}
export function validAdminMutation(req,{siteUrl,key}){
  const received=String(req.get('X-CSRF-Token')||'');
  const expected=csrfForSession(req,key);
  return req.get('Origin')===new URL(siteUrl).origin&&
    req.get('Sec-Fetch-Site')!=='cross-site'&&
    req.is('application/json')&&/^[a-f0-9]{64}$/.test(received)&&
    crypto.timingSafeEqual(Buffer.from(received),Buffer.from(expected));
}

export function mountAdmin(app,express,{enabled,cloudEnabled,paymentProvider,findSession,store,historyStore,siteUrl,key,checkStatus,alertsConfigured}){
  const mailEnabled=()=>typeof cloudEnabled==='function'?cloudEnabled():cloudEnabled;
  const activePaymentProvider=()=>typeof paymentProvider==='function'?paymentProvider():paymentProvider;
  const router=express.Router();
  const guard=async(req,res,next)=>{
    res.set({'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
      'X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"});
    try{
      if(!enabled)return res.status(404).json({message:'Раздел администратора не включён'});
      const user=await findSession(req);
      if(!user)return res.status(401).json({message:'Войдите в личный кабинет'});
      if(!await store.isAdmin(user.user_key))return res.status(403).json({message:'Нет прав администратора'});
      req.admin=user;
      if(!['GET','HEAD'].includes(req.method)&&!validAdminMutation(req,{siteUrl,key}))
        return res.status(403).json({message:'Проверка безопасности не пройдена. Обновите страницу'});
      next();
    }catch(error){next(error);}
  };
  router.use(guard);
  const staticFiles={'/':'admin.html','/admin.css':'admin.css','/admin.js':'admin.js',
    '/history':'history.html','/history.js':'history.js','/history.css':'history.css'};
  for(const [path,file] of Object.entries(staticFiles))router.get(path,(req,res)=>{
    res.sendFile(file,{root:fileURLToPath(new URL('.',import.meta.url))});
  });
  app.use('/admin',router);

  const api=express.Router();
  // Reuse exactly the same guard, not client-supplied role or a hidden URL.
  api.use(guard);
  if(historyStore){
    api.get('/history',async(req,res,next)=>{
      try{res.json({...await historyStore.list(req.query),user:{name:req.admin.name}});}
      catch(error){next(error);}
    });
    api.get('/history/:id',async(req,res,next)=>{
      try{res.json(await historyStore.detail(req.params.id,req.query));}
      catch(error){next(error);}
    });
  }
  api.get('/orders',async(req,res,next)=>{
    try{
      const metadata={csrfToken:csrfForSession(req,key),enabled:mailEnabled(),
        alertsConfigured,user:{name:req.admin.name},activePaymentProvider:await activePaymentProvider(),
        providerHistory:await store.checkoutProviderHistory()};
      if(!mailEnabled())return res.json({...metadata,orders:[],total:0,page:1,pageSize:25,
        summary:{attention:0,delivered:0,inProgress:0}});
      res.json({...metadata,...await store.list(req.query)});
    }catch(error){next(error);}
  });
  api.use((req,res,next)=>mailEnabled()?next():res.status(503).json({message:'Автоматическая отправка доступов ещё не включена'}));
  api.get('/orders/:id',async(req,res,next)=>{
    try{res.json({...await store.detail(req.params.id),csrfToken:csrfForSession(req,key)});}
    catch(error){next(error);}
  });
  api.post('/orders/:id/resend',async(req,res,next)=>{
    try{res.json(await store.resend(req.params.id,req.admin.user_key,req.body));}
    catch(error){next(error);}
  });
  api.post('/orders/:id/password',async(req,res,next)=>{
    try{res.json(await store.revealPassword(req.params.id,req.admin.user_key));}
    catch(error){next(error);}
  });
  api.post('/orders/:id/reset-password',async(req,res,next)=>{
    try{res.json(await store.resetPassword(req.params.id,req.admin.user_key,req.body));}
    catch(error){next(error);}
  });
  api.post('/orders/:id/check',async(req,res,next)=>{
    try{
      const {order}=await store.detail(req.params.id);
      if(order.provider!=='notisend'||!order.provider_message_id)
        throw new SupportError('Нет идентификатора NotiSend для проверки');
      if(['delivered','skipped','soft_bounced','hard_bounced'].includes(order.delivery_status))
        return res.json({ok:true});
      const result=await checkStatus(order.order_id);
      if(!result.claimed)throw new SupportError('Проверка уже идёт или недавно выполнена. Повторите позднее',429);
      await store.audit(req.admin.user_key,req.params.id,result.refreshed?'status:checked':'status:unavailable');
      if(!result.refreshed)throw new SupportError('NotiSend сейчас не ответил. Повторим автоматически',503);
      res.json({ok:true});
    }catch(error){next(error);}
  });
  const safeError=(error,req,res,next)=>{
    if(error instanceof SupportError)return res.status(error.status).json({message:error.message});
    // SQL/provider errors may contain PII or credentials. Never serialize or log them.
    console.error('CLUB_ADMIN_OPERATION_FAILED');
    res.status(500).json({message:'Раздел временно недоступен. Повторите позднее'});
  };
  router.use(safeError);api.use(safeError);
  app.use('/api/admin',api);
}

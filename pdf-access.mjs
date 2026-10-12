import {createHmac,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import express from 'express';

const BUCKET='club-fabrika-pdf';
const REGION='ru-6';
const HOST=`${BUCKET}.s3.${REGION}.storage.selcloud.ru`;
export const PDF_LINK_SECONDS=3600;
const encode=value=>encodeURIComponent(value).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
const sha256=value=>createHash('sha256').update(value).digest('hex');

export function pdfDisposition(name,download){
  const clean=String(name).normalize('NFC').replace(/[\x00-\x1f\x7f]/g,'');
  return `${download?'attachment':'inline'}; filename="club-document.pdf"; filename*=UTF-8''${encode(clean)}`;
}

// AWS Signature V4, GET-only, for our fixed private bucket and catalog keys.
// No caller-controlled hosts, keys, credentials, or expiration values.
export function signPdf(item,download=false,{credentials,now=new Date()}={}){
  const accessKeyId=credentials?.accessKeyId||process.env.SELECTEL_PDF_ACCESS_KEY_ID;
  const secretAccessKey=credentials?.secretAccessKey||process.env.SELECTEL_PDF_SECRET_ACCESS_KEY;
  if(!accessKeyId||!secretAccessKey)throw new Error('PDF_STORAGE_NOT_CONFIGURED');
  if(!/^[a-f0-9]{32}$/.test(item.id))throw new Error('INVALID_PDF_ID');
  const timestamp=now.toISOString().replace(/[:-]|\.\d{3}/g,'');
  const day=timestamp.slice(0,8);
  const scope=`${day}/${REGION}/s3/aws4_request`;
  const path=`/pdf/${item.id}.pdf`;
  const query={
    'X-Amz-Algorithm':'AWS4-HMAC-SHA256',
    'X-Amz-Credential':`${accessKeyId}/${scope}`,
    'X-Amz-Date':timestamp,
    'X-Amz-Expires':String(PDF_LINK_SECONDS),
    'X-Amz-SignedHeaders':'host',
    'response-content-type':'application/pdf',
    'response-content-disposition':pdfDisposition(item.name,download),
    'response-cache-control':'private, max-age=0, must-revalidate',
  };
  const canonicalQuery=Object.entries(query).map(([k,v])=>[encode(k),encode(v)])
    .sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${k}=${v}`).join('&');
  const canonicalRequest=`GET\n${path}\n${canonicalQuery}\nhost:${HOST}\n\nhost\nUNSIGNED-PAYLOAD`;
  const stringToSign=`AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`;
  const signingKey=hmac(hmac(hmac(hmac('AWS4'+secretAccessKey,day),REGION),'s3'),'aws4_request');
  const signature=createHmac('sha256',signingKey).update(stringToSign).digest('hex');
  return `https://${HOST}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export async function loadPdfCatalog(){
  const rows=JSON.parse(await readFile(new URL('./pdf-catalog.json',import.meta.url),'utf8'));
  const catalog=new Map();
  for(const row of rows){
    if(!/^[a-f0-9]{32}$/.test(row.id)||!row.name||catalog.has(row.id))throw new Error('INVALID_PDF_CATALOG');
    catalog.set(row.id,row);
  }
  return catalog;
}

export function rewritePdfLinks(html,catalog){
  const routes=new Map();
  for(const item of catalog.values()){
    for(const source of item.sources||[])routes.set(source,`/api/pdfs/${item.id}`);
  }
  return html.replace(/https:\/\/disk\.yandex\.ru\/[id]\/[A-Za-z0-9_-]+/g,url=>routes.get(url)||url);
}

export function createPdfRouter({catalog,authorize,sign=signPdf,onFailure=()=>{}}){
  const router=express.Router();
  router.get('/:id',async(req,res,next)=>{
    res.set({'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
    try{
      if(!await authorize(req))return res.redirect(303,'/?login=1');
      const item=catalog.get(req.params.id);
      if(!item)return res.status(404).type('text').send('Материал не найден');
      const download=req.query.download;
      if(download!==undefined&&download!=='1')return res.status(400).type('text').send('Неверный режим скачивания');
      let url;
      try{url=await sign(item,download==='1');}
      catch{
        onFailure();
        return res.status(503).type('text').send('Не удалось открыть PDF. Попробуйте ещё раз или обратитесь в службу заботы.');
      }
      return res.redirect(302,url);
    }catch(error){next(error);}
  });
  return router;
}

import {createHmac,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import express from 'express';

const BUCKET='club-fabrika-pdf';
const REGION='ru-6';
const HOST=BUCKET+'.s3.'+REGION+'.storage.selcloud.ru';
export const PODCAST_LINK_SECONDS=3600;
const encode=value=>encodeURIComponent(value).replace(/[!'()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase());
const hmac=(key,value)=>createHmac('sha256',key).update(value).digest();
const sha256=value=>createHash('sha256').update(value).digest('hex');

export async function loadPodcastCatalog(){
  const rows=JSON.parse(await readFile(new URL('./podcast-catalog.json',import.meta.url),'utf8'));
  const catalog=new Map();
  for(const row of rows){
    if(!row||!/^[a-f0-9]{32}$/.test(row.id)||catalog.has(row.id))throw new Error('INVALID_PODCAST_CATALOG');
    catalog.set(row.id,{id:row.id});
  }
  return catalog;
}

function signPodcastObject(item,kind,{credentials,now=new Date()}={}){
  const accessKeyId=credentials?.accessKeyId||process.env.SELECTEL_PDF_ACCESS_KEY_ID;
  const secretAccessKey=credentials?.secretAccessKey||process.env.SELECTEL_PDF_SECRET_ACCESS_KEY;
  if(!accessKeyId||!secretAccessKey)throw new Error('PODCAST_STORAGE_NOT_CONFIGURED');
  if(!item||!/^[a-f0-9]{32}$/.test(item.id))throw new Error('INVALID_PODCAST_ID');
  const object=kind==='audio'?'/audio/'+item.id+'.m4a':kind==='metadata'?'/podcast/'+item.id+'.json':null;
  if(!object)throw new Error('INVALID_PODCAST_OBJECT');
  const contentType=kind==='audio'?'audio/mp4':'application/json; charset=utf-8';
  const filename=kind==='audio'?'podcast.m4a':'podcast.json';
  const timestamp=now.toISOString().replace(/[:-]|\.\d{3}/g,'');
  const day=timestamp.slice(0,8);
  const scope=day+'/'+REGION+'/s3/aws4_request';
  const query={
    'X-Amz-Algorithm':'AWS4-HMAC-SHA256',
    'X-Amz-Credential':accessKeyId+'/'+scope,
    'X-Amz-Date':timestamp,
    'X-Amz-Expires':String(PODCAST_LINK_SECONDS),
    'X-Amz-SignedHeaders':'host',
    'response-content-type':contentType,
    'response-content-disposition':'inline; filename="'+filename+'"',
    'response-cache-control':'private, max-age=0, must-revalidate',
  };
  const canonicalQuery=Object.entries(query).map(([key,value])=>[encode(key),encode(value)])
    .sort(([left],[right])=>left<right?-1:left>right?1:0)
    .map(([key,value])=>key+'='+value).join('&');
  const canonicalRequest='GET\n'+object+'\n'+canonicalQuery+'\nhost:'+HOST+'\n\nhost\nUNSIGNED-PAYLOAD';
  const stringToSign='AWS4-HMAC-SHA256\n'+timestamp+'\n'+scope+'\n'+sha256(canonicalRequest);
  const signingKey=hmac(hmac(hmac(hmac('AWS4'+secretAccessKey,day),REGION),'s3'),'aws4_request');
  const signature=createHmac('sha256',signingKey).update(stringToSign).digest('hex');
  return 'https://'+HOST+object+'?'+canonicalQuery+'&X-Amz-Signature='+signature;
}

export function signPodcastAudio(item,options={}){return signPodcastObject(item,'audio',options);}
export function signPodcastMetadata(item,options={}){return signPodcastObject(item,'metadata',options);}

function privateHeaders(res){
  res.set({'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
}
function validMetadata(value){
  return Boolean(value&&typeof value==='object'&&typeof value.title==='string'&&typeof value.author==='string'&&typeof value.description==='string'&&Number.isSafeInteger(value.durationSeconds)&&value.durationSeconds>0&&Array.isArray(value.chapters)&&value.chapters.length>0&&value.chapters.length<=48&&value.chapters.every(chapter=>chapter&&typeof chapter.time==='string'&&/^\d{1,2}:\d{2}$/.test(chapter.time)&&typeof chapter.title==='string'&&Number.isSafeInteger(chapter.seconds)&&chapter.seconds>=0&&chapter.seconds<value.durationSeconds));
}

export function createPodcastRouter({catalog,authorize,signAudio=signPodcastAudio,signMetadata=signPodcastMetadata,fetchImpl=fetch,onFailure=()=>{}}){
  const router=express.Router();
  router.get('/:id/audio',async(req,res,next)=>{
    privateHeaders(res);
    try{
      if(!await authorize(req))return res.redirect(303,'/?login=1');
      const item=catalog.get(req.params.id);
      if(!item)return res.status(404).type('text').send('Подкаст не найден');
      let url;
      try{url=await signAudio(item);}
      catch{onFailure('audio');return res.status(503).type('text').send('Не удалось открыть аудио. Попробуйте ещё раз или обратитесь в службу заботы.');}
      return res.redirect(302,url);
    }catch(error){next(error);}
  });
  router.get('/:id/metadata',async(req,res,next)=>{
    privateHeaders(res);
    try{
      if(!await authorize(req))return res.status(401).json({message:'Войдите в клуб, чтобы открыть подкаст'});
      const item=catalog.get(req.params.id);
      if(!item)return res.status(404).json({message:'Подкаст не найден'});
      try{
        const response=await fetchImpl(await signMetadata(item),{cache:'no-store',redirect:'error'});
        if(!response.ok)throw new Error('PODCAST_METADATA_FETCH_FAILED');
        const text=await response.text();
        if(text.length>32768)throw new Error('PODCAST_METADATA_TOO_LARGE');
        const metadata=JSON.parse(text);
        if(!validMetadata(metadata))throw new Error('INVALID_PODCAST_METADATA');
        return res.type('application/json').send(JSON.stringify(metadata));
      }catch{
        onFailure('metadata');
        return res.status(503).json({message:'Не удалось загрузить описание подкаста. Попробуйте ещё раз.'});
      }
    }catch(error){next(error);}
  });
  return router;
}

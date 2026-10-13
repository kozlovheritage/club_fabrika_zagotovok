import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import express from 'express';
import {createPodcastRouter,loadPodcastCatalog,signPodcastAudio,signPodcastMetadata,PODCAST_LINK_SECONDS} from './podcast-access.mjs';

const catalog=await loadPodcastCatalog();
const item=[...catalog.values()][0];

test('public catalog contains only an opaque podcast ID',async()=>{
  assert.equal(catalog.size,1);
  assert.equal(item.id,'eac9865e38a92514932232d5409aa1d0');
  const rows=JSON.parse(await readFile(new URL('./podcast-catalog.json',import.meta.url),'utf8'));
  assert.deepEqual(Object.keys(rows[0]),['id']);
  const html=await readFile(new URL('./index.html',import.meta.url),'utf8');
  assert.match(html,/podcastId:'eac9865e38a92514932232d5409aa1d0'/);
  assert.match(html,/info\.description/);
  assert.ok(html.includes("fetch('/api/podcasts/'+id+'/metadata'"));
  assert.ok(html.includes("source.src='/api/podcasts/'+id+'/audio'"));
});

test('audio and metadata sign only fixed private object paths with the correct MIME types',()=>{
  const credentials={accessKeyId:'test-key',secretAccessKey:'test-secret'};
  const now=new Date('2026-10-14T08:00:00Z');
  const audio=new URL(signPodcastAudio(item,{credentials,now}));
  assert.equal(audio.hostname,'club-fabrika-pdf.s3.ru-6.storage.selcloud.ru');
  assert.equal(audio.pathname,'/audio/'+item.id+'.m4a');
  assert.equal(audio.searchParams.get('response-content-type'),'audio/mp4');
  assert.equal(audio.searchParams.get('X-Amz-Expires'),String(PODCAST_LINK_SECONDS));
  assert.match(audio.searchParams.get('X-Amz-Signature'),/^[a-f0-9]{64}$/);
  const metadata=new URL(signPodcastMetadata(item,{credentials,now}));
  assert.equal(metadata.pathname,'/podcast/'+item.id+'.json');
  assert.equal(metadata.searchParams.get('response-content-type'),'application/json; charset=utf-8');
  assert.match(metadata.searchParams.get('X-Amz-Signature'),/^[a-f0-9]{64}$/);
  assert.throws(()=>signPodcastAudio({...item,id:'../outside'},{credentials}),/INVALID_PODCAST_ID/);
});

test('router requires an active club session before signing or returning podcast metadata',async()=>{
  const calls=[];
  const fixture={title:'Sample podcast',author:'Sample author',description:'Sample summary',durationSeconds:60,chapters:[{time:'00:00',seconds:0,title:'Start'}]};
  const app=express();
  app.use('/api/podcasts',createPodcastRouter({
    catalog,
    authorize:async req=>req.headers['x-test-session']==='active',
    signAudio:async row=>{calls.push('audio:'+row.id);return 'https://storage.test/audio/'+row.id+'.m4a?sig=test';},
    signMetadata:async row=>{calls.push('metadata:'+row.id);return 'https://storage.test/podcast/'+row.id+'.json?sig=test';},
    fetchImpl:async url=>{assert.match(String(url),/^https:\/\/storage\.test\/podcast\//);return new Response(JSON.stringify(fixture),{status:200,headers:{'content-type':'application/json'}});},
  }));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const request=(path,session)=>fetch(base+path,{redirect:'manual',headers:session?{'x-test-session':session}:{}});
  try{
    const deniedAudio=await request('/api/podcasts/'+item.id+'/audio');
    assert.equal(deniedAudio.status,303);
    assert.equal(deniedAudio.headers.get('location'),'/?login=1');
    assert.equal((await request('/api/podcasts/'+item.id+'/metadata')).status,401);
    assert.equal(calls.length,0);
    assert.equal((await request('/api/podcasts/'+'0'.repeat(32)+'/audio','active')).status,404);
    const audio=await request('/api/podcasts/'+item.id+'/audio','active');
    assert.equal(audio.status,302);
    assert.match(audio.headers.get('location'),/^https:\/\/storage\.test\/audio\//);
    assert.equal(audio.headers.get('cache-control'),'private, no-store');
    assert.equal(audio.headers.get('referrer-policy'),'no-referrer');
    const response=await request('/api/podcasts/'+item.id+'/metadata','active');
    assert.equal(response.status,200);
    assert.deepEqual(await response.json(),fixture);
    assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.deepEqual(calls,['audio:'+item.id,'metadata:'+item.id]);
  }finally{
    if(server.closeAllConnections)server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});

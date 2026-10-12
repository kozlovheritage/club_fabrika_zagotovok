import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import express from 'express';
import {createPdfRouter,loadPdfCatalog,rewritePdfLinks,signPdf,pdfDisposition,PDF_LINK_SECONDS} from './pdf-access.mjs';

const catalog=await loadPdfCatalog();
const item=[...catalog.values()][0];
test('catalog contains every original; legal links remain unchanged',async()=>{
  assert.equal(catalog.size,40);
  const html=await readFile(new URL('./index.html',import.meta.url),'utf8');
  const rewritten=rewritePdfLinks(html,catalog);
  const remaining=[...new Set(rewritten.match(/https:\/\/disk\.yandex\.ru\/[id]\/[A-Za-z0-9_-]+/g)||[])];
  assert.deepEqual(remaining.sort(),[
    'https://disk.yandex.ru/i/F9KEtKAMrIzKzw',
    'https://disk.yandex.ru/i/TpVA_h_RWP1UyQ',
    'https://disk.yandex.ru/i/vIxEZ0HkXsj42Q',
  ].sort());
  const referenced=[...rewritten.matchAll(/\/api\/pdfs\/([a-f0-9]{32})/g)].map(m=>m[1]);
  for(const id of referenced)assert.ok(catalog.has(id));
  assert.equal(new Set(referenced).size,40);
  assert.match(rewritten,/function pdfActions/);
  assert.match(rewritten,/\?download=1/);
});

test('signer fixes region, destination, method scope, filename and lifetime',()=>{
  const url=new URL(signPdf(item,false,{credentials:{accessKeyId:'test-key',secretAccessKey:'test-secret'},now:new Date('2026-10-12T07:00:00Z')}));
  assert.equal(url.hostname,'club-fabrika-pdf.s3.ru-6.storage.selcloud.ru');
  assert.equal(url.pathname,`/pdf/${item.id}.pdf`);
  assert.equal(url.searchParams.get('X-Amz-Expires'),String(PDF_LINK_SECONDS));
  assert.equal(url.searchParams.get('X-Amz-Date'),'20261012T070000Z');
  assert.equal(url.searchParams.get('X-Amz-Credential'),'test-key/20261012/ru-6/s3/aws4_request');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'),'host');
  assert.match(url.searchParams.get('X-Amz-Signature'),/^[a-f0-9]{64}$/);
  assert.equal(url.searchParams.get('response-content-disposition'),pdfDisposition(item.name,false));
  const download=new URL(signPdf(item,true,{credentials:{accessKeyId:'test-key',secretAccessKey:'test-secret'}}));
  assert.match(download.searchParams.get('response-content-disposition'),/^attachment;/);
  assert.throws(()=>signPdf({...item,id:'../outside'},false,{credentials:{accessKeyId:'test-key',secretAccessKey:'test-secret'}}),/INVALID_PDF_ID/);
});

test('PDF delivery checks the existing session before revealing or signing any file',async()=>{
  const calls=[];
  let fail=false;
  const app=express();
  app.use('/api/pdfs',createPdfRouter({catalog,authorize:async req=>req.headers['x-test-session']==='active-premium',sign:async(row,download)=>{
    if(fail)throw new Error('DO_NOT_EXPOSE_SIGNING_SECRETS');
    calls.push({id:row.id,download});
    return `https://club-fabrika-pdf.s3.ru-6.storage.selcloud.ru/pdf/${row.id}.pdf?test=1`;
  }}));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const request=(path,session)=>fetch(base+path,{redirect:'manual',headers:session?{'x-test-session':session}:{}});
  try{
    for(const session of [undefined,'expired','basic','inactive']){
      const r=await request(`/api/pdfs/${item.id}`,session);
      assert.equal(r.status,303);assert.equal(r.headers.get('location'),'/?login=1');
      assert.match(r.headers.get('cache-control'),/no-store/);
    }
    assert.equal(calls.length,0);
    const open=await request(`/api/pdfs/${item.id}`,'active-premium');
    assert.equal(open.status,302);
    assert.match(open.headers.get('location'),/^https:\/\/club-fabrika-pdf\.s3\.ru-6\.storage\.selcloud\.ru\/pdf\//);
    assert.equal(open.headers.get('referrer-policy'),'no-referrer');
    assert.equal(calls.at(-1).download,false);
    const download=await request(`/api/pdfs/${item.id}?download=1`,'active-premium');
    assert.equal(download.status,302);assert.equal(calls.at(-1).download,true);
    assert.equal((await request('/api/pdfs/not-a-file','active-premium')).status,404);
    assert.equal((await request(`/api/pdfs/${'0'.repeat(32)}`,'active-premium')).status,404);
    for(const query of ['download=0','download=../','download=1&download=1']){
      assert.equal((await request(`/api/pdfs/${item.id}?${query}`,'active-premium')).status,400);
    }
    assert.equal(calls.length,2);
    fail=true;
    const failure=await request(`/api/pdfs/${item.id}`,'active-premium');
    assert.equal(failure.status,503);
    assert.doesNotMatch(await failure.text(),/DO_NOT_EXPOSE|Signature|secret/i);
  }finally{await new Promise(resolve=>server.close(resolve));}
});

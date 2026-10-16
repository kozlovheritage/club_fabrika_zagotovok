import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const html=await readFile(new URL('./index.html',import.meta.url),'utf8');
const load=html.slice(html.indexOf('async function loadNutritionPodcastMetadata('),html.indexOf('function formatPodcastDuration('));

test('metadata cache separates podcasts, deduplicates pending requests and retries failures',async()=>{
  const calls=[];
  let fail=true;
  const context=vm.createContext({
    nutritionPodcastMetadata:new Map(),nutritionPodcastMetadataRequest:new Map(),
    fetch:async url=>{
      calls.push(url);
      if(url.includes('b'.repeat(32))&&fail)return {ok:false,status:503};
      return {ok:true,json:async()=>({
        title:url,author:'',description:'Recording',durationSeconds:363,
        chapters:[{time:'00:00',seconds:0,title:'Start'}]
      })};
    }
  });
  vm.runInContext(load,context);
  const first='a'.repeat(32),second='b'.repeat(32);
  const [a,duplicate]=await Promise.all([
    context.loadNutritionPodcastMetadata(first),context.loadNutritionPodcastMetadata(first)
  ]);
  assert.equal(a,duplicate);
  assert.equal(calls.length,1);
  await assert.rejects(context.loadNutritionPodcastMetadata(second),/503/);
  fail=false;
  const b=await context.loadNutritionPodcastMetadata(second);
  assert.notEqual(a.title,b.title);
  assert.equal(await context.loadNutritionPodcastMetadata(first),a);
  assert.equal(calls.length,3);
  await assert.rejects(context.loadNutritionPodcastMetadata('../invalid'),/INVALID_PODCAST_ID/);
});

test('health list refreshes titles for every podcast, not only the first one',()=>{
  assert.ok(html.includes("for(const podcastCard of list.querySelectorAll('[data-podcast-id]'))"));
  assert.match(html,/t:'Подкаст с гематологом', podcastId:'e377621dae7fdd9ca033055cf8341fae'/);
});

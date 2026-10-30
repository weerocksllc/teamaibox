import assert from 'node:assert/strict';
import test from 'node:test';
import {ResultPages} from '../src/public/result-pages.mjs';

test('search and notifications expose all pages beyond the old total limits',async()=>{
 for(const size of [50,100]){
  const records=Array.from({length:237},(_,i)=>({id:String(i).padStart(4,'0'),createdAt:'2026-09-16T00:00:00.000Z'}));
  const pages=new ResultPages(async path=>{
   const url=new URL(path,'https://test');const id=url.searchParams.get('before_id');
   const index=id===null?0:records.findIndex(r=>r.id===id)+1;
   assert.equal(Number(url.searchParams.get('limit')),size);
   return {data:records.slice(index,index+size)};
  },size);
  pages.reset('/api/messages');while(pages.hasMore)await pages.load();
  assert.deepEqual(pages.items,records);
 }
});
test('late search responses cannot replace a newer query',async()=>{
 let resolveOld;const pending=new Promise(resolve=>resolveOld=resolve);
 const pages=new ResultPages(url=>url.includes('old')?pending:Promise.resolve({data:[]}),50);
 pages.reset('/search?q=old');const old=pages.load();pages.reset('/search?q=new');await pages.load();
 resolveOld({data:[{id:'old',createdAt:'2026-09-16T00:00:00.000Z'}]});assert.equal(await old,null);assert.deepEqual(pages.items,[]);
});
test('repeated clicks share a request and duplicate cursors are rejected',async()=>{
 let calls=0;const pages=new ResultPages(async()=>{calls++;return {data:[{id:'a',createdAt:'2026-09-16T00:00:00.000Z'}]}},1);
 pages.reset('/search');await Promise.all([pages.load(),pages.load()]);assert.equal(calls,1);
 await assert.rejects(pages.load(),/did not advance/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const code=await readFile(new URL('../src/public/app.js',import.meta.url),'utf8');
const body=code.match(/async function downloadEntry\([^\n]+/)[0];
for(const name of ['办公资料.txt','renamed.txt','季度报告 2026.pdf'])test('same-origin download preserves '+name,async()=>{
 let clicked=false,removed=false,url;const link={click(){clicked=true;},remove(){removed=true;}};
 const context=vm.createContext({json:async p=>{url=p;return {reference_id:'01a0aaa3-6f5b-7847-9540-1dba933b0013'};},document:{createElement:()=>link,body:{append(){}}},show:()=>assert.fail('download failed'),entry:{id:'file-id',name}});
 await vm.runInContext(body+';downloadEntry(entry,2)',context);
 assert.equal(url,'/api/v1/files/entries/file-id/download?version=2');
 assert.equal(link.href,'/api/v1/objects/references/01a0aaa3-6f5b-7847-9540-1dba933b0013/content');
 assert.equal(link.download,name);assert.ok(clicked&&removed);
});

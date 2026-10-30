import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pendingCastingNotices, loadCastingNotices} from '../src/casting/invitation-notices.mjs';
const item={id:'f66308e3-64d7-445f-a717-168fae0291bb',sessionId:'b7f8eb6d-eb99-410d-a1c8-61993db2a3ac',object:'cast.viewer_invitation',state:'pending',expiresAt:'2026-09-09T09:00:00Z'};
const envelope=data=>({object:'list',data});
test('notices only include unexpired pending invitations and no private fields',()=>{
  const now=Date.parse('2026-09-09T08:00:00Z');
  assert.deepEqual(pendingCastingNotices(envelope([item]),now),[{id:item.id,expiresAt:item.expiresAt}]);
  for(const state of ['accepted','declined','expired','revoked'])assert.deepEqual(pendingCastingNotices(envelope([{...item,state}]),now),[]);
  assert.deepEqual(pendingCastingNotices(envelope([item]),Date.parse(item.expiresAt)),[]);
  assert.throws(()=>pendingCastingNotices(envelope([item,item]),now));
  assert.throws(()=>pendingCastingNotices(envelope([{...item,id:'invalid'}]),now));
});
test('reading notices uses the authenticated account and never mutates or joins',async()=>{
  const requests=[];
  await loadCastingNotices({fetchImpl:async(path,options)=>{requests.push({path,options});return new Response(JSON.stringify(envelope([])));}});
  assert.equal(requests.length,1);assert.equal(requests[0].path,'/api/v1/casting/invitations');
  assert.equal(requests[0].options.credentials,'same-origin');assert.equal(requests[0].options.body,undefined);
  await assert.rejects(loadCastingNotices({fetchImpl:async()=>new Response('{}',{status:403})}));
});
test('global workbench has a visible invitation banner and real notification badge, not demo notifications',async()=>{
  const source=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
  assert.match(source,/casting-invitation-banner/);assert.match(source,/canReceiveCasting/);
  assert.match(source,/castingNotices.length.*action-badge/);assert.doesNotMatch(source,/const notifications =/);
  assert.doesNotMatch(source,/api\.join|api\.accept|mediaCredential/);
});

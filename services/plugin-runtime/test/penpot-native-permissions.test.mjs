import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { PenpotNativePermissions } from '../src/penpot-native-permissions.mjs';

test('subscription query uses a fixed private endpoint and rechecks each live team', async()=>{
  const profileId='11111111-1111-4111-8111-111111111111',connectionId='22222222-2222-4222-8222-222222222222';
  const teamId='33333333-3333-4333-8333-333333333333',key='x'.repeat(43);
  let canRead=true,replyId=connectionId,teams=[teamId],checked=0;
  const permissions=new PenpotNativePermissions({backendOrigin:'http://penpot:6060',backendKey:key,
    teamCeiling:async binding=>{checked++;assert.deepEqual(binding,{profileId,teamId});return {canRead};},
    fetchImplementation:async (url,options)=>{
      assert.equal(url.pathname,'/api/main/methods/teamaibox-subscription-access');
      assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,'Bearer '+key);
      assert.deepEqual(JSON.parse(options.body),{'target-profile-id':profileId,'connection-id':connectionId});
      return Response.json({profileId,connectionId:replyId,teamIds:teams});
    }});
  await permissions.checkSubscriptions({profileId,connectionId});assert.equal(checked,1);
  canRead=false;await assert.rejects(permissions.checkSubscriptions({profileId,connectionId}),{status:403});assert.equal(checked,2);
  replyId=profileId;await assert.rejects(permissions.checkSubscriptions({profileId,connectionId}),{status:403});
  replyId=connectionId;teams=[teamId,teamId];await assert.rejects(permissions.checkSubscriptions({profileId,connectionId}),{status:403});assert.equal(checked,2);
});

test('native permission contract uses camelCase responses and exact target checks', async () => {
  const target = { profileId: randomUUID(), fileId: randomUUID(), pageId: randomUUID() };
  const key = randomBytes(32).toString('base64url'), teamId = randomUUID();
  let value = { ...target, teamId, canRead: true, canEdit: true }, calls = 0;
  const service = new PenpotNativePermissions({ backendOrigin: 'http://native.invalid', backendKey: key,
    fetchImplementation: async (url, options) => {
      calls++;
      assert.equal(url.pathname, '/api/main/methods/teamaibox-file-access');
      assert.deepEqual(JSON.parse(options.body), { 'target-profile-id': target.profileId, 'file-id': target.fileId, 'page-id': target.pageId });
      assert.equal(options.headers.authorization, 'Bearer ' + key);
      assert.equal(options.headers.cookie, undefined); assert.equal(options.headers.origin, undefined);
      assert.equal(options.redirect, 'error');
      return Response.json(value);
    } });
  assert.deepEqual(await service.check(target), value);
  value.canEdit = false; assert.equal((await service.check(target)).canEdit, false);
  value = { ...value, pageId: randomUUID() }; await assert.rejects(service.check(target), { code: 'penpot_target_denied' });
  value = { ...target, teamId, canRead: true, canEdit: 'true' }; await assert.rejects(service.check(target));
  value = { ...value, canRead: false, canEdit: true }; await assert.rejects(service.check(target));
  value = { text: 'x'.repeat(8193) }; await assert.rejects(service.check(target));
  const previous = calls;
  await assert.rejects(service.check({ ...target, fileId: 'invalid' })); assert.equal(calls, previous);
});

test('unavailable native authority fails closed without publishing upstream errors', async () => {
  const target = { profileId: randomUUID(), fileId: randomUUID(), pageId: randomUUID() };
  for (const fetchImplementation of [async () => new Response('private upstream error', { status: 500 }),
    async () => { throw Error('private upstream error'); }, async () => new Response('invalid json')]) {
    const service = new PenpotNativePermissions({ backendOrigin: 'http://native.invalid',
      backendKey: randomBytes(32).toString('base64url'), fetchImplementation });
    await assert.rejects(service.check(target), error => error.code === 'penpot_target_denied' && !error.message.includes('private'));
  }
});

test('managed directory is a live ceiling and never grants missing native file access',async()=>{
  const target={profileId:randomUUID(),fileId:randomUUID(),pageId:randomUUID()};
  let native={...target,teamId:randomUUID(),canRead:true,canEdit:true};
  let ceiling={canRead:true,canEdit:false},checks=0;
  const service=new PenpotNativePermissions({backendOrigin:'http://native.invalid',
    backendKey:randomBytes(32).toString('base64url'),fetchImplementation:async()=>Response.json(native),
    teamCeiling:async input=>{checks++;assert.deepEqual(input,{profileId:target.profileId,teamId:native.teamId});return ceiling;}});
  assert.equal((await service.check(target)).canEdit,false);
  ceiling={canRead:true,canEdit:true};native.canEdit=false;
  assert.equal((await service.check(target)).canEdit,false);
  native.canEdit=true;assert.equal((await service.check(target)).canEdit,true);
  ceiling={canRead:false,canEdit:true};await assert.rejects(service.check(target),{code:'penpot_target_denied'});
  const previous=checks;native.canRead=false;ceiling={canRead:true,canEdit:true};
  await assert.rejects(service.check(target));assert.equal(checks,previous);
});

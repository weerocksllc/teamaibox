import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeInstanceBusy } from '../src/opencode-native-activity.mjs';
const idle = { '/session/status': {}, '/pty': [], '/permission': [], '/question': [], '/api/session/active': {data:{}} };
const check = overrides => nativeInstanceBusy({ request: async (method, path) => {
  assert.equal(method, 'GET'); return Response.json({...idle, ...overrides}[path]);
}});
test('native idle requires both session engines and all interaction sources to be known and idle', async () => { assert.equal(await check({}), false); });
for (const [name, overrides] of Object.entries({
  running: {'/session/status':{ses_x:{type:'busy'}}},
  retrying: {'/session/status':{ses_x:{type:'retry'}}},
  terminal: {'/pty':[{id:'pty_x',status:'running'}]},
  permission: {'/permission':[{id:'per_x'}]},
  question: {'/question':[{id:'que_x'}]},
  malformed: {'/session/status':[]},
  unknown: {'/pty':null},
  v2running: {'/api/session/active':{data:{ses_v2:{type:'running'}}}},
  v2unknown: {'/api/session/active':{}},
})) test(`${name} prevents idle reclamation`, async () => assert.equal(await check(overrides), true));
test('unavailable engine is not interpreted as idle', async () => {
  assert.equal(await nativeInstanceBusy({request:async()=>{throw Error('offline');}}),true);
  assert.equal(await nativeInstanceBusy({request:async()=>new Response(null,{status:503})}),true);
});
test('exited terminal and idle session do not hold compute forever', async () => {
  assert.equal(await check({'/pty':[{status:'exited'}],'/session/status':{ses_x:{type:'idle'}}}),false);
});

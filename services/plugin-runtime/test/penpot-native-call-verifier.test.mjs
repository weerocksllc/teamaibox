import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PenpotNativeCallVerifier } from '../src/penpot-native-call-verifier.mjs';

function fixture() {
  const identityId = randomUUID(), runtimeId = randomUUID(), sandboxKey = 'sandbox.' + randomUUID().replaceAll('-', '');
  let authenticated = true, afterRead = () => {};
  let binding = { identityId, runtimeId, sessionID: 'ses_native', platformSessionId: randomUUID(),
    profileId: randomUUID(), fileId: randomUUID(), pageId: randomUUID(), connectionId: randomUUID(), generation: 1 };
  const call = { server: 'teamaibox-penpot', tool: 'execute_code', sessionID: binding.sessionID, messageID: 'msg_native', callID: 'call_native' };
  const session = { id: call.sessionID, directory: '/workspace/project one', time: {} };
  const message = { info: { id: call.messageID, sessionID: call.sessionID, role: 'assistant', time: {} },
    parts: [{ type: 'tool', sessionID: call.sessionID, messageID: call.messageID, callID: call.callID,
      tool: 'teamaibox-penpot_execute_code', state: { status: 'running' } }] };
  const requests = [], credential = Symbol();
  const route = { ownerIdentityId: identityId, sandboxKey, native: { async request(method, path) {
    requests.push({ method, path });
    if (path === '/session/' + call.sessionID) return Response.json(session);
    afterRead(); return Response.json(message);
  } } };
  const verifier = new PenpotNativeCallVerifier({ routes: { resolve: async () => route },
    authenticateRuntime: async value => authenticated && value === credential ? { identityId, runtimeId, sandboxKey } : null,
    resolveBinding: async () => structuredClone(binding) });
  return { verifier, call, credential, route, session, message, requests,
    verify: () => verifier.verify(credential, call),
    change: patch => { binding = { ...binding, ...patch }; },
    afterRead: fn => { afterRead = fn; }, revoke: () => { authenticated = false; } };
}

test('verifies an actual native call representation through read-only owned transport', async () => {
  const f = fixture();
  const result = await f.verify(); assert.equal(result.identityId, f.route.ownerIdentityId);
  assert.deepEqual(f.requests.map(r => r.method), ['GET', 'GET']);
  assert.match(f.requests[1].path, /directory=%2Fworkspace%2Fproject%20one$/);
  assert.equal(Object.keys(result).length, 2);
});

test('refuses forged context, another owner/runtime and completed or ambiguous native calls', async () => {
  const cases = [f => { f.call.server = 'other'; }, f => { f.route.ownerIdentityId = randomUUID(); },
    f => { f.route.sandboxKey = 'other'; }, f => { f.message.info.role = 'user'; },
    f => { f.message.info.sessionID = 'ses_other'; }, f => { f.message.info.time.completed = Date.now(); },
    f => { f.message.parts[0].callID = 'different'; }, f => { f.message.parts[0].state.status = 'completed'; },
    f => { f.message.parts[0].tool = 'other_execute_code'; }, f => { f.message.parts.push(f.message.parts[0]); },
    f => { f.session.directory = '/workspace/../private'; }, f => { f.session.time.archived = Date.now(); }];
  for (const alter of cases) { const f = fixture(); alter(f); await assert.rejects(f.verify(), { code: 'penpot_call_denied', status: 403 }); }
  const f = fixture(); await assert.rejects(f.verifier.verify(Symbol(), f.call), { code: 'penpot_call_denied' });
});

test('refuses selection and runtime credential withdrawal during the native read', async () => {
  for (const field of ['platformSessionId', 'runtimeId', 'sessionID', 'connectionId', 'generation', 'profileId', 'fileId', 'pageId']) {
    const f = fixture(); f.afterRead(() => f.change({ [field]: field === 'generation' ? 2 : randomUUID() }));
    await assert.rejects(f.verify(), { code: 'penpot_call_denied' }, field);
  }
  const f = fixture(); f.afterRead(f.revoke); await assert.rejects(f.verify(), { code: 'penpot_call_denied' });
});

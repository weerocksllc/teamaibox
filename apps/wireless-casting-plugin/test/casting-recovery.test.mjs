import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { fetchCastingJsonV1, readCastingSessionV1 } from '../src/public/casting-client-v1.mjs';

test('hung headers or body have a deadline; mutating requests are never resubmitted', async () => {
  for (const bodyHangs of [false, true]) {
    let calls = 0, signal;
    await assert.rejects(fetchCastingJsonV1('/test', { method:'POST' }, {
      timeoutMs:20, fetchImpl:async (_path, options) => {
        calls++; signal = options.signal;
        return bodyHangs ? { ok:true, json:() => new Promise(() => {}) } : new Promise(() => {});
      },
    }), error => error.code === 'cast_request_timeout');
    assert.equal(calls, 1);
    assert.equal(signal.aborted, true);
  }
});

test('fast success, authorization denial and invalid JSON keep their original meaning', async () => {
  assert.deepEqual(await fetchCastingJsonV1('/test', {}, {fetchImpl:async()=>({ok:true,json:async()=>({ok:1})})}), {ok:1});
  await assert.rejects(fetchCastingJsonV1('/test', {}, {fetchImpl:async()=>({ok:false,status:403,json:async()=>({error:{code:'access_denied'}})})}), e=>e.code==='access_denied');
  await assert.rejects(fetchCastingJsonV1('/test', {}, {fetchImpl:async()=>({ok:true,json:async()=>{throw Error('invalid');}})}), e=>e.code==='cast_response_invalid');
});

test('terminal sessions never request or preserve viewers', async () => {
  for (const state of ['stopped','expired','failed']) {
    assert.deepEqual(await readCastingSessionV1({current:async()=>({id:'one',state,perspective:'initiator'}),viewers:()=>assert.fail('terminal viewer query')}), {session:null,viewers:[]});
  }
});

test('stop between current and viewers reconciles once; permission errors do not retry', async () => {
  let reads=0, viewers=0;
  assert.deepEqual(await readCastingSessionV1({
    current:async()=> ++reads===1 ? {id:'one',state:'streaming',perspective:'initiator'} : null,
    viewers:async()=>{viewers++;throw {code:'cast_session_terminal'};},
  }), {session:null,viewers:[]});
  assert.equal(reads,2);assert.equal(viewers,1);
  reads=0;
  await assert.rejects(readCastingSessionV1({current:async()=>{reads++;return {id:'one',state:'streaming',perspective:'initiator'};},viewers:async()=>{throw {code:'access_denied'};}}),e=>e.code==='access_denied');
  assert.equal(reads,1);
});

test('actual empty-session renderer clears previous viewer rows and pairing details', async () => {
  const source=await readFile(new URL('../src/public/app.js',import.meta.url),'utf8');
  const nodes=new Map();
  const $=key=>{if(!nodes.has(key))nodes.set(key,{hidden:false,textContent:'stale',replaceChildren(){this.textContent='';}});return nodes.get(key);};
  const context=vm.createContext({$,state:{session:null,loading:false,streamedSessionId:null,layoutSessionId:null},
    document:{documentElement:{dataset:{}}},presentationV1:()=>({mode:'setup',active:false}),ACTIVE_STATES:new Set(['streaming'])});
  vm.runInContext(source.slice(source.indexOf('function renderViewers('),source.indexOf('function renderInvitations('))+
    source.slice(source.indexOf('function renderSession('),source.indexOf('function render()'))+'\nrenderSession();',context);
  assert.equal($('#viewers-card').hidden,true);assert.equal($('#viewer-list').textContent,'');
  assert.equal($('#receiver-pin').textContent,'—');assert.equal($('#receiver-name').textContent,'—');
  assert.equal($('#share-card').hidden,true);assert.equal($('#invitee').textContent,'');
});

test('expired login clears stale controls and cannot be revived by polling', async () => {
  const source = await readFile(new URL('../src/public/app.js',import.meta.url),'utf8');
  const state={capabilityReady:true,loading:true,actorIdentityId:'member',permissions:new Set(['cast:use']),
    session:{id:'session'},invitations:[{}],acceptedInvitations:new Map([['session',{}]]),availability:{state:'ready'}};
  let cleared=0, discarded=0, rendered=0;
  const context=vm.createContext({state,$:()=>({hidden:true}),viewingResume:{clear(){cleared++;}},
    discardMediaGrant(){discarded++;},showError(error){assert.equal(error.code,'invalid_session');},render(){rendered++;}});
  vm.runInContext(source.slice(source.indexOf('function failClosed('),source.indexOf('function initials(')),context);
  context.failClosed({code:'invalid_session'});
  assert.equal(state.actorIdentityId,null);assert.equal(state.permissions.size,0);
  assert.equal(state.session,null);assert.equal(state.invitations.length,0);assert.equal(state.acceptedInvitations.size,0);
  assert.equal(state.availability,null);assert.equal(state.capabilityReady,false);
  assert.equal(cleared,1);assert.equal(discarded,1);assert.equal(rendered,1);
  assert.match(source,/new Set\(\["invalid_session", "not_found"/);
});

test('removed/end feedback cancels automatic resume; transport loss does not erase consent', async () => {
  const source = await readFile(new URL('../src/public/app.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('async function handleUnexpectedMediaDisconnect('), source.indexOf('async function leaveViewing('));
  for (const [reason, message, clears] of [['removed', 'viewingRemoved', 1], ['ended', 'viewingEnded', 1], ['connection_lost', 'viewingDisconnected', 0]]) {
    let cleared = 0, discarded = 0, rendered = 0;
    const notices = [];
    const context = vm.createContext({ mediaSessionId: 'current', state: { acceptedInvitations: new Map([['current', {}]]) },
      viewingResume: { clear() { cleared++; } },
      discardMediaGrant() { discarded++; }, notify: value => notices.push(value),
      t: value => value, render() { rendered++; }, api: { leave: async () => {} }, browserInstanceId: 'browser' });
    vm.runInContext(fn, context);
    await context.handleUnexpectedMediaDisconnect('old', reason);
    assert.deepEqual(notices, []);
    await context.handleUnexpectedMediaDisconnect('current', reason);
    assert.deepEqual(notices, [message]);
    assert.equal(context.state.viewerDisconnect.message, message);
    assert.equal(context.state.acceptedInvitations.has('current'), clears === 0);
    assert.equal(cleared, clears); assert.equal(discarded, 1); assert.equal(rendered, 1);
  }
});

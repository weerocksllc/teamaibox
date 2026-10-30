import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { presentationV1, joinAfterStartV1, sourceReconciliationV1 } from '../src/public/casting-ui-policy-v1.mjs';
import { validateCastingDraftV1 } from '../src/public/casting-client-v1.mjs';

async function formDraft(audience) {
  const source=await readFile(new URL('../src/public/app.js',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('function draft()'),source.indexOf('async function submitSession'));
  const state={selectedUserIds:new Set(['22222222-2222-4222-8222-222222222222'])};
  const controls={'#team-select':{value:'33333333-3333-4333-8333-333333333333'},'#team-id':{value:''},'#ttl':{value:'1800'}};
  const draft=Function('document','state','$',body+'; return draft();')(
    {querySelector:()=>({value:audience})},state,key=>controls[key]);
  return {draft,state};
}

for (const audience of ['owner_only','selected_users','selected_team']) {
  test(`form submits only ${audience} targets when other choices remain selected`, async () => {
    const {draft,state}=await formDraft(audience);
    const result=validateCastingDraftV1(draft,'11111111-1111-4111-8111-111111111111');
    assert.equal(result.valid,true);
    assert.equal(result.body.viewer_user_ids.length,audience==='selected_users'?1:0);
    assert.equal(result.body.viewer_team_id,audience==='selected_team'?'33333333-3333-4333-8333-333333333333':null);
    assert.equal(state.selectedUserIds.size,1,'switching the form does not erase a draft choice');
  });
}

test('stage separates waiting, live and disconnected sender from receiver lifetime', () => {
  assert.equal(presentationV1({session:null}).mode, 'idle');
  const session = {state:'pairing', perspective:'initiator'};
  assert.deepEqual(presentationV1({session}), {active:true,mode:'waiting',disconnected:false,pairingVisible:true});
  assert.equal(presentationV1({session,previouslyStreaming:true}).disconnected,true);
  assert.equal(presentationV1({session:{...session,state:'streaming'}}).pairingVisible,false);
  assert.equal(presentationV1({session:{...session,perspective:'manager'}}).pairingVisible,false);
  assert.equal(presentationV1({session:{...session,state:'expired'}}).active,false);
  const ended={...session,state:'streaming',sourceState:'disconnected'};
  assert.equal(presentationV1({session:ended}).mode,'waiting');
  assert.equal(presentationV1({session:ended}).disconnected,true);
  assert.equal(presentationV1({session:ended}).pairingVisible,true);
  assert.equal(presentationV1({session:{...ended,sourceState:'connected'}}).mode,'streaming');
});
test('only initiator explicit start/apply may join browser output automatically', () => {
  const session = {state:'pairing',perspective:'initiator',outputSinks:['browser']};
  assert.equal(joinAfterStartV1({session,canView:true}),true);
  for(const perspective of ['viewer','manager']) assert.equal(joinAfterStartV1({session:{...session,perspective},canView:true}),false);
  assert.equal(joinAfterStartV1({session,canView:false}),false);
  assert.equal(joinAfterStartV1({session:{...session,outputSinks:['hdmi']},canView:true}),false);
  assert.equal(joinAfterStartV1({session:{...session,state:'stopped'},canView:true}),false);
});
test('versioned source snapshots reconcile missed stop and resume without replay', () => {
  const session={id:'session-one',sourceState:'connected',sourceStateRevision:2};
  assert.equal(sourceReconciliationV1({session}).action,'resume');
  const stopped=sourceReconciliationV1({previousSessionId:session.id,previousRevision:2,
    session:{...session,sourceState:'disconnected',sourceStateRevision:5}});
  assert.deepEqual(stopped,{action:'suspend',sessionId:session.id,revision:5});
  assert.equal(sourceReconciliationV1({previousSessionId:session.id,previousRevision:5,
    session:{...session,sourceStateRevision:4}}).action,'reject');
  assert.equal(sourceReconciliationV1({previousSessionId:session.id,previousRevision:5,
    session:{...session,sourceState:'connected',sourceStateRevision:6}}).action,'resume');
});
test('unavailable source health is not a revision rollback, and ended sessions reset tracking', () => {
  const before={previousSessionId:'session-one',previousRevision:4};
  const session={id:'session-one',state:'streaming',sourceState:'unknown',sourceStateRevision:1};
  assert.deepEqual(sourceReconciliationV1({...before,session}),
    {action:'unchanged',sessionId:session.id,revision:4});
  assert.equal(presentationV1({session}).mode,'waiting');
  for(const state of ['stopping','failed','stopped','expired']) {
    assert.deepEqual(sourceReconciliationV1({...before,session:{...session,state}}),
      {action:'reset',sessionId:null,revision:null});
  }
  assert.equal(sourceReconciliationV1({...before,session:{...session,sourceState:'connected',sourceStateRevision:5}}).action,'resume');
  assert.equal(sourceReconciliationV1({...before,session:{...session,sourceState:'connected',sourceStateRevision:3}}).action,'reject');
});
test('picture precedes settings, with secondary information in native disclosure', async () => {
  const html=await readFile(new URL('../src/public/index.html',import.meta.url),'utf8');
  const source=await readFile(new URL('../src/public/app.js',import.meta.url),'utf8');
  assert.ok(html.indexOf('id="browser-video"') < html.indexOf('id="configuration-card"'));
  assert.ok(html.indexOf('id="cast-more"') < html.indexOf('id="configuration-card"'));
  assert.match(html,/<details id="cast-more"/);
  assert.match(source.slice(source.indexOf('async function submitSession'),source.indexOf('async function stopSession')), /joinAfterStartV1.*await joinViewing/);
  assert.doesNotMatch(source.slice(source.indexOf('async function refresh()'),source.indexOf('function draft()')), /api\.join|joinViewing/);
});
test('invitations stay above the stage, and only accept-and-watch click can join', async () => {
  const html=await readFile(new URL('../src/public/index.html',import.meta.url),'utf8');
  const source=await readFile(new URL('../src/public/app.js',import.meta.url),'utf8');
  assert.ok(html.indexOf('id="invitations-card"') < html.indexOf('id="session-card"'));
  assert.equal((html.match(/id="invitations-card"/g)||[]).length,1);
  assert.match(source,/accept\.addEventListener\("click", \(\) => void acceptAndWatch/);
  const handler=source.slice(source.indexOf('async function acceptAndWatch'),source.indexOf('async function acceptInvitationOnly'));
  assert.match(handler,/await acceptInvitationOnly/);assert.match(handler,/perspective === "viewer".*await joinViewing/);
  const refresh=source.slice(source.indexOf('async function refresh'),source.indexOf('function draft'));
  assert.doesNotMatch(refresh,/acceptAndWatch|joinViewing|api\.accept/);
  assert.doesNotMatch(html + source, /接受邀请不会自动播放|Accepting an invitation never autoplays/,
    'the invitation action already accepts and joins; do not ask for a redundant click');
  assert.match(source, /explicitJoin: "Select Join to watch and listen in this browser\."/);
});

test('disconnect explanation remains in the player after transient notices expire', async () => {
  const source = await readFile(new URL('../src/public/app.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function renderPlayer('), source.indexOf('function renderInvitees('));
  const paragraph = {};
  const nodes = new Map();
  const $ = key => { if (!nodes.has(key)) nodes.set(key, { classList:{toggle(){}}, querySelector:()=>paragraph }); return nodes.get(key); };
  const state = { busy:false, capabilityReady:true, viewerDisconnect:{sessionId:'current',message:'viewingRemoved'} };
  const session = { id:'current', perspective:'viewer', outputSinks:['browser'],sourceState:'waiting' };
  const render = Function('$','can','state','mediaSessionId','mediaCredential','mediaClient','acceptedInvitation','mediaConnectionState','t','videoVisibleV1',
    body+';return renderPlayer;')($,()=>true,state,null,null,{isConnected:()=>false,hasVideoTrack:()=>false},()=>({}), 'disconnected',x=>x,()=>false);
  render(session); assert.equal(paragraph.textContent,'viewingRemoved');
  render(session); assert.equal(paragraph.textContent,'viewingRemoved');
  render({...session,id:'different'}); assert.equal(paragraph.textContent,'explicitJoin');
});

test('rendering an established stream does not hide video when its join credential expires', async () => {
  const source = await readFile(new URL('../src/public/app.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('function renderPlayer('), source.indexOf('function renderInvitees('));
  const elements = new Map();
  const $ = key => {
    if (!elements.has(key)) elements.set(key, { hidden: false, disabled: false, muted: false,
      textContent: '', classList: { toggle() {} }, querySelector() { return {}; } });
    return elements.get(key);
  };
  const session = { id: 'current-room', perspective: 'initiator', outputSinks: ['browser'], sourceState: 'connected' };
  const render = Function('$', 'can', 'state', 'mediaSessionId', 'mediaCredential', 'mediaCredentialExpiresAt',
    'mediaClient', 'acceptedInvitation', 'mediaConnectionState', 't', 'videoVisibleV1',
    body + '; return renderPlayer;')($, () => true, { busy: false, capabilityReady: true }, session.id,
      'already-used-join-secret', '2000-01-01T00:00:00Z',
      { isConnected: () => true, hasVideoTrack: () => true }, () => null, 'connected', value => value,
      ({ joined, hasVideoTrack }) => joined && hasVideoTrack);
  render(session);
  assert.equal($('#join').hidden, true);
  assert.equal($('#leave').hidden, false);
  assert.equal($('#browser-video').hidden, false);
  assert.equal($('#media-status').textContent, 'joined');
  render({ ...session, id: 'different-room' });
  assert.equal($('#browser-video').hidden, true, 'an old room cannot appear joined to a new session');
});

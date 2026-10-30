import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MonitorInput,MonitorRooms,instruction} from '../src/virtual-computers/monitor-control.mjs';

test('monitor parser gates fragmented/coalesced input and rejects clipboard, resize and argument injection',()=>{
 const input=new MonitorInput();let allowed=false;
 assert.equal(input.receive(Buffer.from('3.ke'),()=>allowed),'');
 assert.equal(input.receive(Buffer.from('y,2.65,1.1;'+instruction('sync',1)),()=>allowed),instruction('sync',1));
 allowed=true;
 assert.equal(input.receive(Buffer.from(instruction('key',65,1)+instruction('mouse',20,30,1)+instruction('size',1,1)+instruction('argv',1,'text/plain','username')+instruction('clipboard',1,'text/plain')),()=>allowed),instruction('key',65,1)+instruction('mouse',20,30,1));
 assert.equal(input.release(),instruction('key',65,0)+instruction('mouse',20,30,0));assert.equal(input.release(),'');
 assert.throws(()=>input.receive(Buffer.from('x.key;'),()=>true));
 const unicode=new MonitorInput();assert.equal(unicode.receive(Buffer.from(instruction('ack','😀',0,0)),()=>false),instruction('ack','😀',0,0));
});
test('owner multi-page, handoff, shared mode, view-only, immediate revoke and held-key cleanup',()=>{
 const rooms=new MonitorRooms();const released=[];
 const member=(viewerId,identityId,role)=>({viewerId,identityId,role,computerId:'pc',sessionId:identityId+'-session',name:identityId,
  releaseInput:()=>released.push(viewerId),close(){this.releaseInput();rooms.leave(this);}});
 const a=member('a','owner','owner'),b=member('b','owner','owner'),guest=member('g','guest','control'),view=member('v','viewer','view');
 [a,b,guest,view].forEach(c=>rooms.join(c));
 const act=(c,action,extra={})=>rooms.action('pc',c,{viewerId:c.viewerId,action,...extra});
 assert.equal(rooms.allowed(a),true);assert.equal(rooms.allowed(b),false);assert.equal(rooms.allowed(guest),false);
 assert.throws(()=>act(view,'claim'));assert.throws(()=>act(guest,'claim'));assert.throws(()=>act(guest,'shared'));
 assert.throws(()=>rooms.action('pc',view,{viewerId:a.viewerId,action:'reclaim'}));
 act(a,'handoff',{targetViewerId:guest.viewerId});assert.equal(rooms.allowed(a),false);assert.equal(rooms.allowed(guest),true);assert.ok(released.includes('a'));
 act(b,'reclaim');assert.equal(rooms.allowed(guest),false);assert.equal(rooms.allowed(b),true);
 act(b,'shared');assert.ok([a,b,guest].every(c=>rooms.allowed(c)));assert.equal(rooms.allowed(view),false);
 rooms.updateGrant('pc','guest','view');assert.equal(rooms.allowed(guest),false);assert.ok(released.includes('g'));
 rooms.updateGrant('pc','viewer',null);assert.equal(rooms.snapshot('pc',a,'a','owner').participants.length,3);
 act(a,'reclaim');assert.ok(!rooms.allowed(b));act(a,'release');assert.equal(rooms.allowed(a),false);act(b,'claim');assert.equal(rooms.allowed(b),true);
 rooms.leave(b);assert.equal(rooms.allowed(a),true);rooms.leave(a);rooms.leave(guest);
 assert.deepEqual(rooms.snapshot('pc',a,'a','owner').participants,[]);
});

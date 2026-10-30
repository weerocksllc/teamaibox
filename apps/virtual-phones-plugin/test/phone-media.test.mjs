import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import {PhoneMediaSession,phoneViewportPoint} from '../src/public/phone-media.mjs';

function fixture() {
  let socket,peer;const states=[];
  const channel=label=>({label,readyState:'open',bufferedAmount:0,sent:[],send(x){this.sent.push(JSON.parse(x));},close(){this.readyState='closed';}});
  class Socket {constructor(url){this.url=url;socket=this;this.sent=[];this.readyState=1;this.bufferedAmount=0;}send(x){this.sent.push(JSON.parse(x));}close(){this.readyState=3;this.onclose?.();}}
  class Peer {constructor(config){peer=this;this.config=config;this.channels=[];this.candidates=[];this.connectionState='new';}
    createDataChannel(label){const value=channel(label);this.channels.push(value);return value;}
    async setRemoteDescription(value){this.remoteDescription=value;}async addIceCandidate(value){this.candidates.push(value);}
    async createAnswer(){return {type:'answer',sdp:'synthetic-test-answer'};}async setLocalDescription(value){this.localDescription=value;}
    close(){this.connectionState='closed';this.onconnectionstatechange?.();}}
  const ticket={id:randomUUID(),phoneId:randomUUID(),token:'a'.repeat(43),kind:'control'};
  const session=new PhoneMediaSession({ticket,origin:'https://box.test',WebSocketImpl:Socket,PeerConnection:Peer,onState:x=>states.push(x)});
  const message=async x=>{socket.onmessage({data:JSON.stringify(x)});await tick();};
  return {session,socket,peer,states,ticket,message,channel};
}
test('one-use secret is first WSS frame, never URL; only selected phone and LAN negotiation',async()=>{
  const f=fixture();try {
    assert.equal(f.socket.url,`wss://box.test/api/v1/virtual-phones/${f.ticket.phoneId}/connections/${f.ticket.id}/signal`);
    assert.ok(!f.socket.url.includes(f.ticket.token));f.socket.onopen();assert.deepEqual(f.socket.sent[0],{type:'phone.authenticate',token:f.ticket.token});
    await f.message({type:'phone.signal.ready'});assert.equal(f.socket.sent[1].device_id,`phone-${f.ticket.phoneId}`);
    await f.message({message_type:'config',ice_servers:[{urls:'turn:untrusted.test'}]});
    await f.message({message_type:'device_info',device_info:{}});assert.deepEqual(f.socket.sent.at(-1).payload.ice_servers,[]);
    assert.deepEqual(f.peer.config,{iceServers:[]});assert.deepEqual(f.peer.channels.map(c=>c.label),['input-channel']);
  }finally{f.session.close();}
});
test('candidate-before-offer and upstream device_msg protocol are serialized',async()=>{
  const f=fixture();try{
    await f.message({message_type:'device_msg',payload:{type:'ice-candidate',candidate:'candidate:synthetic',mid:'0',mLineIndex:0}});
    assert.equal(f.peer.candidates.length,0);
    await f.message({message_type:'device_msg',payload:{type:'offer',sdp:'synthetic-test-offer'}});
    assert.equal(f.peer.candidates.length,1);assert.equal(f.socket.sent.at(-1).payload.sdp,'synthetic-test-answer');
    f.peer.connectionState='connected';f.peer.onconnectionstatechange();assert.equal(f.states.at(-1),'connected');
  }finally{f.session.close();}
});
test('navigation, keyboard and touch have no delayed replay or debug channel',()=>{
  const f=fixture();try{
    const input=f.peer.channels[0],control=f.channel('device-control');f.peer.ondatachannel({channel:control});
    assert.ok(f.session.key('KeyA','keydown'));assert.ok(f.session.touch([{id:0,x:300,y:700}],true));
    assert.ok(f.session.control('home','down'));assert.equal(control.sent[0].command,'home');
    assert.equal(f.session.control('adb','down'),false);assert.equal(f.session.touch([{id:0,x:720,y:0}],true),false);
    const adb=f.channel('adb-channel');f.peer.ondatachannel({channel:adb});assert.equal(adb.readyState,'closed');
    input.readyState='connecting';assert.equal(f.session.key('KeyB','keydown'),false);assert.equal(input.sent.length,2);
    input.readyState='open';input.bufferedAmount=16385;f.session.key('KeyC','keyup');assert.equal(f.peer.connectionState,'closed');
  }finally{f.session.close();}
});
test('transport loss or oversized signalling closes the actual browser peer',()=>{
  for(const fail of [f=>f.socket.onclose(),f=>f.socket.onmessage({data:'x'.repeat(262145)})]){
    const f=fixture();fail(f);assert.equal(f.peer.connectionState,'closed');assert.equal(f.session.key('KeyA','keydown'),false);f.session.close();
  }
  assert.throws(()=>new PhoneMediaSession({ticket:{},origin:'http://box.test'}));
});
test('touch coordinates account for letterboxing and capture beyond edges',()=>{
  const rect={left:10,top:20,width:1000,height:1280};
  assert.equal(phoneViewportPoint(rect,20,200),null);
  assert.deepEqual(phoneViewportPoint(rect,510,660),{x:360,y:640});
  assert.deepEqual(phoneViewportPoint(rect,2000,3000,{clamp:true}),{x:719,y:1279});
  assert.equal(phoneViewportPoint({...rect,width:0},100,100),null);
});

test('unavailable browser media is distinguished before opening a signalling socket',()=>{
  const ticket={id:randomUUID(),phoneId:randomUUID(),token:'a'.repeat(43),kind:'control'};
  let socketCreated=false;
  class Socket {constructor(){socketCreated=true;}}
  const unavailable=[null,{},class {constructor(){throw Object.assign(new Error('policy'),{name:'SecurityError'});}},
    class {constructor(){throw Object.assign(new Error('unsupported'),{name:'NotSupportedError'});}}];
  for(const PeerConnection of unavailable)
    assert.throws(()=>new PhoneMediaSession({ticket,origin:'https://box.test',PeerConnection,WebSocketImpl:Socket}),{code:'phone_browser_media_unavailable'});
  assert.equal(socketCreated,false);
  class UnexpectedFailure {constructor(){throw new Error('unexpected');}}
  assert.throws(()=>new PhoneMediaSession({ticket,origin:'https://box.test',PeerConnection:UnexpectedFailure,WebSocketImpl:Socket}),/^Error: unexpected$/);
});

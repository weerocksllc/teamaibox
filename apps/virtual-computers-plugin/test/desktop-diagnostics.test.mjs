import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/public/desktop-diagnostics.js',import.meta.url),'utf8');
function setup(search='?diagnostics=1') {
  const parsers=[], nodes=[], timers=[], handlers={};
  class Events { listeners={}; addEventListener(k,fn){this.listeners[k]=fn;} emit(k,data){this.listeners[k]?.(data);} }
  class Socket extends Events {}
  class Audio extends Events {
    state='running';sampleRate=48000;currentTime=1;baseLatency=.01;outputLatency=.02;
    createBufferSource(){const node=new Events();node.start=()=>{};return node;}
  }
  const ctx={location:{search},URLSearchParams,Date,atob,window:{WebSocket:Socket,AudioContext:Audio,addEventListener:(k,f)=>handlers[k]=f},
    Guacamole:{Parser:class{constructor(){parsers.push(this);}receive(){}}},
    document:{documentElement:{lang:'zh-CN'},body:{append(){}},createElement(){const n={style:{},append(){}};nodes.push(n);return n;}},
    setInterval(fn){timers.push(fn);return 1;},clearInterval(id){ctx.cleared=id;}};
  vm.runInNewContext(source,ctx);
  return {ctx,parsers,Socket,Audio,handlers,stats(){timers[0]();return JSON.parse(nodes.find(n=>n.id).textContent);}};
}
test('normal desktop has no observers, panel or background timer',()=>{
  const h=setup('');assert.equal(h.ctx.window.WebSocket,h.Socket);assert.equal(h.ctx.window.AudioContext,h.Audio);assert.equal(h.parsers.length,0);
});
test('only desktop audio PCM is counted; display and credentials never enter output',()=>{
  const h=setup();new h.ctx.window.WebSocket('wss://box/unrelated');assert.equal(h.parsers.length,0);
  const socket=new h.ctx.window.WebSocket('wss://box/api/v1/virtual-computers/id/desktop-tunnel?token=private');socket.emit('open');
  const send=h.parsers[0].oninstruction;
  send('required',['password']);send('blob',['4',btoa('private')]);send('audio',['1','audio/L16;rate=48000,channels=2']);
  send('blob',['1',btoa(String.fromCharCode(0,1,0,2))]);send('end',['1']);send('blob',['1',btoa('ignored')]);
  const s=h.stats();assert.equal(s.audioBytes,4);assert.equal(s.nonzeroAudioBytes,2);assert.equal(s.socketOpens,1);
  assert.doesNotMatch(JSON.stringify(s),/private|password|token|ignored/);
});
test('audio playback counts start and end separately; page exit cancels timer',()=>{
  const h=setup(), audio=new h.ctx.window.AudioContext(), buffer=audio.createBufferSource();
  buffer.start(1.05);assert.equal(h.stats().audioBuffersStarted,1);assert.equal(h.stats().audioBuffersEnded,0);
  buffer.emit('ended');assert.equal(h.stats().audioBuffersEnded,1);assert.equal(h.stats().audioContextState,'running');
  audio.state='suspended';audio.emit('statechange');assert.equal(h.stats().audioContextState,'suspended');
  h.handlers.pagehide();assert.equal(h.ctx.cleared,1);
});
test('round-trip samples are bounded and are not labelled end-to-end latency',()=>{
  const h=setup();new h.ctx.window.WebSocket('wss://box/desktop-tunnel');
  for(let i=0;i<200;i++)h.parsers[0].oninstruction('',['ping',String(Date.now()-10)]);
  assert.equal(h.stats().transportRoundTripSamples,120);assert.equal(h.stats().endToEndLatencyMs,undefined);
});

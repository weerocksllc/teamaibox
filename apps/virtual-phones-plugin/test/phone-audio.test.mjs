import assert from 'node:assert/strict';
import test from 'node:test';
import {createPhoneAudio} from '../src/public/phone-audio.mjs';
import {phoneDiagnosticNumber} from '../src/public/phone-diagnostics.mjs';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
class Track extends EventTarget {kind='audio';readyState='live';muted=false;}
class Stream {tracks=[];addTrack(track){this.tracks.push(track);}}
class Audio extends EventTarget {
  paused=true;muted=false;volume=1;readyState=4;srcObject=null;calls=0;denied=true;next=null;
  play(){this.calls++;if(this.next)return this.next;
    if(this.denied)return Promise.reject(Object.assign(new Error('gesture required'),{name:'NotAllowedError'}));
    this.paused=false;this.dispatchEvent(new Event('playing'));return Promise.resolve();}
  pause(){this.paused=true;this.dispatchEvent(new Event('pause'));}
}
function fixture(){const audio=new Audio(),button=new EventTarget(),status={};
  const controller=createPhoneAudio({audio,button,status,translate:key=>key,MediaStreamImpl:Stream});
  return {audio,button,status,controller,track:new Track()};}

test('autoplay denial is visible separately from connection, and a real gesture resumes without replacing the track',async()=>{
  const f=fixture();f.controller.attach(f.track);await tick();
  assert.equal(f.controller.snapshot().state,'blocked');assert.equal(f.button.hidden,false);
  assert.equal(f.status.textContent,'audio_blocked');assert.equal(f.status.hidden,false);
  const stream=f.audio.srcObject;f.audio.denied=false;f.controller.activate({isTrusted:true});await tick();
  assert.equal(f.controller.snapshot().state,'playing');assert.equal(f.button.hidden,true);
  assert.equal(f.audio.srcObject,stream);assert.equal(f.track.readyState,'live');
});
test('synthetic events and gestures before an audio track do not request playback',async()=>{
  const f=fixture();f.controller.activate({isTrusted:true});assert.equal(f.audio.calls,0);
  f.controller.attach(f.track);await tick();f.controller.activate({isTrusted:false});assert.equal(f.audio.calls,1);
});
test('explicit audio button remains a fallback and does not alter mute or system volume',async()=>{
  const f=fixture();f.controller.attach(f.track);await tick();f.audio.denied=false;f.audio.volume=0;
  f.button.dispatchEvent(new Event('click'));await tick();assert.equal(f.controller.snapshot().state,'muted');
  assert.equal(f.audio.volume,0);assert.equal(f.button.hidden,true);
});
test('later pause becomes visible and the next interaction restores playback',async()=>{
  const f=fixture();f.audio.denied=false;f.controller.attach(f.track);await tick();
  f.audio.pause();assert.equal(f.controller.snapshot().state,'paused');assert.equal(f.button.hidden,false);
  f.controller.activate({isTrusted:true});await tick();assert.equal(f.status.textContent,'audio_playing');
  const calls=f.audio.calls;f.controller.activate({isTrusted:true});assert.equal(f.audio.calls,calls);
});
test('ended, muted, and waiting tracks are not claimed as playing',async()=>{
  const f=fixture();f.audio.denied=false;f.controller.attach(f.track);await tick();
  f.track.muted=true;f.track.dispatchEvent(new Event('mute'));assert.equal(f.status.textContent,'audio_waiting');
  f.track.muted=false;f.track.dispatchEvent(new Event('unmute'));assert.equal(f.status.textContent,'audio_playing');
  f.audio.dispatchEvent(new Event('waiting'));assert.equal(f.status.textContent,'audio_waiting');
  f.audio.dispatchEvent(new Event('playing'));assert.equal(f.status.textContent,'audio_playing');
  f.track.readyState='ended';f.track.dispatchEvent(new Event('ended'));assert.equal(f.status.textContent,'audio_ended');
  assert.equal(f.controller.snapshot().liveTracks,0);assert.equal(f.button.hidden,true);
});
test('reset ignores late play promises, clears old tracks, and reconnect has independent state',async()=>{
  const f=fixture();let reject;
  f.audio.next=new Promise((_,r)=>{reject=r;});f.controller.attach(f.track);f.controller.reset();
  reject(Object.assign(new Error('old denial'),{name:'NotAllowedError'}));await tick();
  assert.equal(f.controller.snapshot().state,'none');assert.equal(f.audio.srcObject,null);
  assert.equal(f.button.hidden,true);assert.equal(f.status.hidden,true);assert.equal(f.track.readyState,'live');
  f.audio.next=null;f.audio.denied=false;f.controller.attach(new Track());await tick();
  f.track.dispatchEvent(new Event('ended'));assert.equal(f.controller.snapshot().state,'playing');
  assert.equal(f.audio.srcObject.tracks.length,1);
});
test('duplicate and non-audio tracks are ignored',async()=>{
  const f=fixture();f.controller.attach({...f.track,kind:'video'});f.controller.attach(f.track);f.controller.attach(f.track);await tick();
  assert.equal(f.audio.calls,1);assert.equal(f.audio.srcObject.tracks.length,1);
});
test('real playback failures remain visible and can be retried',async()=>{
  const f=fixture();f.audio.next=Promise.reject(Object.assign(new Error('format'),{name:'NotSupportedError'}));
  f.controller.attach(f.track);await tick();assert.equal(f.status.textContent,'audio_failed');assert.equal(f.button.hidden,false);
  f.audio.next=null;f.audio.denied=false;f.button.dispatchEvent(new Event('click'));await tick();assert.equal(f.status.textContent,'audio_playing');
});
test('audio energy display distinguishes small signal, exact zero and unknown',()=>{
  assert.equal(phoneDiagnosticNumber(0),'0');assert.equal(phoneDiagnosticNumber(null),'—');
  assert.equal(phoneDiagnosticNumber(undefined),'—');assert.equal(phoneDiagnosticNumber(0.0000000412),'4.120e-8');
  assert.equal(phoneDiagnosticNumber(0.00049),'4.900e-4');assert.equal(phoneDiagnosticNumber(0.209123),'0.209');
});

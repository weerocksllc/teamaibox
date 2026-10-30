import test from 'node:test';
import assert from 'node:assert/strict';
import {PhoneBrowserCapture} from '../src/public/phone-browser-capture.mjs';
const id='10000000-0000-4000-8000-000000000001';
class Track extends EventTarget{kind='video';readyState='live';stops=0;stop(){this.readyState='ended';this.stops++;}}
function fixture(){
  const track=new Track(),stream={getVideoTracks:()=>[track],getAudioTracks:()=>[],getTracks:()=>[track]};
  const calls=[],peers=[];
  class Peer extends EventTarget{
    iceGatheringState='complete';connectionState='new';closed=false;
    constructor(options){super();calls.push(['peer',options]);peers.push(this);}
    addTransceiver(value,options){assert.equal(value,track);calls.push(['transceiver',options]);return {setCodecPreferences:value=>calls.push(['codecs',value])};}
    async createOffer(){return {type:'offer',sdp:'synthetic-offer'};}
    async setLocalDescription(value){this.localDescription=value;}
    async setRemoteDescription(value){calls.push(['answer',value]);this.connectionState='connected';this.onconnectionstatechange?.();}
    close(){this.closed=true;}
  }
  const deps={mediaDevices:{async getUserMedia(value){calls.push(['permission',value]);return stream;}},PeerConnection:Peer,
    videoCapabilities:()=>({codecs:[{mimeType:'video/VP8'},{mimeType:'video/H264'}]}),
    async exchange(value){calls.push(['exchange',value]);return {sourceId:value.sourceId,answerSdp:'synthetic-answer'};},
    async revoke(value){calls.push(['revoke',value]);},onState:state=>calls.push(['state',state])};
  return {track,stream,calls,peers,deps};
}
test('opening a page does not request permission; explicit start is video-only and VP8',async()=>{
  const f=fixture(),capture=new PhoneBrowserCapture(f.deps);assert.deepEqual(f.calls,[]);assert.equal(capture.state,'off');
  await capture.start(id);assert.equal(capture.state,'sending');
  const permission=f.calls.find(x=>x[0]==='permission')[1];assert.equal(permission.audio,false);assert.equal(permission.video.frameRate.max,15);
  assert.deepEqual(f.calls.find(x=>x[0]==='peer')[1],{iceServers:[],bundlePolicy:'max-bundle'});
  assert.deepEqual(f.calls.find(x=>x[0]==='codecs')[1],[{mimeType:'video/VP8'}]);
  await capture.stop();assert.equal(f.track.readyState,'ended');assert.ok(f.peers[0].closed);assert.equal(capture.stream,null);
});
test('permission accepted after stop is immediately released and never sent',async()=>{
  const f=fixture();let grant;f.deps.mediaDevices.getUserMedia=()=>new Promise(r=>grant=r);
  const c=new PhoneBrowserCapture(f.deps),start=c.start(id),rejected=assert.rejects(start,{message:'camera_stopped'});
  await c.stop();grant(f.stream);await rejected;assert.equal(f.track.stops,1);assert.equal(f.peers.length,0);
});
test('permission denied does not create a peer or expose browser error text',async()=>{
  const f=fixture();f.deps.mediaDevices.getUserMedia=async()=>{throw Object.assign(Error('private device label'),{name:'NotAllowedError'});};
  const c=new PhoneBrowserCapture(f.deps);await assert.rejects(c.start(id),{message:'camera_permission_denied'});assert.equal(f.peers.length,0);
});
test('stop during signalling closes capture immediately, regardless of late response',async()=>{
  const f=fixture();let answer,entered;const pending=new Promise(r=>entered=r);
  f.deps.exchange=value=>{entered();return new Promise(r=>answer=()=>r({sourceId:id,answerSdp:'synthetic'}));};
  const c=new PhoneBrowserCapture(f.deps),start=c.start(id),rejected=assert.rejects(start,{message:'camera_stopped'});await pending;
  await c.stop();assert.equal(f.track.readyState,'ended');assert.ok(f.peers[0].closed);answer();await rejected;
});
test('browser permission withdrawal and page leave stop capture without implicit restart',async()=>{
  for(const event of ['ended','pagehide']){
    const f=fixture(),page=new EventTarget(),c=new PhoneBrowserCapture(f.deps);c.bindPage(page);await c.start(id);
    (event==='ended'?f.track:page).dispatchEvent(new Event(event));await new Promise(r=>setTimeout(r,0));
    assert.equal(c.state,'off');assert.equal(f.track.readyState,'ended');assert.equal(f.calls.filter(x=>x[0]==='permission').length,1);await c.dispose();
  }
});
test('unexpected audio is stopped and never attached to WebRTC',async()=>{
  const f=fixture(),audio=new Track();audio.kind='audio';f.stream.getAudioTracks=()=>[audio];f.stream.getTracks=()=>[f.track,audio];
  const c=new PhoneBrowserCapture(f.deps);await assert.rejects(c.start(id),{message:'camera_video_only_required'});
  assert.equal(f.peers.length,0);assert.equal(audio.readyState,'ended');
});
test('permission change stops a still-live track and removes its observer',async()=>{
  const f=fixture(),permission=Object.assign(new EventTarget(),{state:'granted'});
  f.deps.permissions={query:async value=>{assert.deepEqual(value,{name:'camera'});return permission;}};
  const c=new PhoneBrowserCapture(f.deps);await c.start(id);
  permission.state='denied';permission.dispatchEvent(new Event('change'));
  assert.equal(c.state,'off');assert.equal(f.track.readyState,'ended');assert.equal(f.track.stops,1);
  permission.dispatchEvent(new Event('change'));assert.equal(f.track.stops,1);await c.dispose();
});
test('unsupported permission descriptor preserves track-ended handling',async()=>{
  const f=fixture();f.deps.permissions={query:async()=>{throw TypeError('unsupported descriptor');}};
  const c=new PhoneBrowserCapture(f.deps);await c.start(id);f.track.dispatchEvent(new Event('ended'));
  assert.equal(c.state,'off');await c.dispose();
});
test('a signalling answer without a media connection cannot keep the camera on indefinitely',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture();f.deps.PeerConnection.prototype.setRemoteDescription=async function(){this.connectionState='connecting';};
  const c=new PhoneBrowserCapture(f.deps);await c.start(id);assert.equal(c.state,'connecting');
  t.mock.timers.tick(15000);await Promise.resolve();assert.equal(c.state,'off');
  assert.equal(f.track.readyState,'ended');assert.ok(f.peers[0].closed);
  assert.equal(f.calls.filter(x=>x[0]==='permission').length,1);await c.dispose();
});

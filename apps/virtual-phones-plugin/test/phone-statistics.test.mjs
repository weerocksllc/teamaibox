import test from 'node:test';
import assert from 'node:assert/strict';
import {phoneStatistics} from '../src/public/phone-statistics.mjs';
test('numeric counters only, selected network pair and correct seconds-to-ms averages',()=>{
  const r=new Map([['v',{type:'inbound-rtp',kind:'video',frameWidth:720,frameHeight:1280,framesDecoded:300,framesDropped:0,framesPerSecond:30,totalDecodeTime:.6,jitterBufferDelay:3,jitterBufferEmittedCount:300,ssrc:123}],
    ['a',{type:'inbound-rtp',kind:'audio',packetsReceived:500,totalAudioEnergy:2,totalSamplesReceived:480000}],
    ['t',{type:'transport',selectedCandidatePairId:'p'}],['p',{type:'candidate-pair',state:'succeeded',currentRoundTripTime:.003,remoteCandidateId:'secret'}],
    ['remote',{type:'remote-candidate',address:'10.64.0.19'}],['d',{type:'data-channel',label:'input-channel',state:'open',messagesSent:4}]]);
  const s=phoneStatistics(r);assert.equal(s.video.decodeMs,2);assert.equal(s.video.jitterBufferMs,10);assert.equal(s.roundTripMs,3);
  assert.equal(s.audio.totalAudioEnergy,2);assert.equal(s.input.messagesSent,4);
  assert.doesNotMatch(JSON.stringify(s),/secret|address|ssrc|192\.168/);
});
test('unsupported or invalid counters are unknown, never fabricated zeros',()=>{
  const s=phoneStatistics(new Map([['v',{type:'inbound-rtp',kind:'video',framesDecoded:0,framesDropped:NaN,framesPerSecond:-1,totalDecodeTime:0}]]));
  assert.equal(s.video.framesDecoded,0);assert.equal(s.video.framesDropped,null);assert.equal(s.video.framesPerSecond,null);assert.equal(s.video.decodeMs,null);
  assert.equal(s.audio,null);assert.equal(s.roundTripMs,null);
});

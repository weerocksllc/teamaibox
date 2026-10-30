import test from 'node:test';
import assert from 'node:assert/strict';
import {BUDGETS,validateActualIphone} from '../casting_actual_iphone_contract.mjs';
import {canonical,digest} from '../browser_smoke_common.mjs';
function fixture(){return {runId:'casting-actual-iphone-20261010-a999',status:'passed',budgets:BUDGETS,systemTrustBrowser:true,
  certificates:[{protocol:'TLS 1.3'}],userMediaRetained:false,pairingCredentialsRetained:false,eightViewerMediaAccepted:false,
  glassToGlassLatencyMeasured:false,avSyncMeasured:false,fullTaskAccepted:false,source:{content:'dedicated-pattern-and-660Hz-tone'},
  initiatorAutomaticallyJoined:true,cleanup:{sourceStopped:true,sessionStopped:true,signedOut:true},
  cycles:Array.from({length:3},(_,n)=>({number:n+1,videoReadyMs:1000,reloadVideoReadyMs:2000,decodedFrames:600,
    audioPackets:1000,audioEnergyDelta:10,audioConcealmentFraction:0,sourceStopFeedbackMs:1000,
    stoppedSample:{sourceEnded:true,sourceFeedbackVisible:true,video:{hidden:true,hasStream:false}},
    samples:Array.from({length:11},(_,i)=>({at:new Date(1789000000000+i*2000).toISOString(),
      video:{width:498,height:1080,hasStream:true,hidden:false,paused:false},
      rtp:[{kind:'video',framesDecoded:i*60},{kind:'audio',packetsReceived:i*100,totalAudioEnergy:i,
        totalSamplesReceived:1000+i*96000,concealedSamples:0}]}))}))};}
function seal(r){const {evidenceDigest,...b}=r;return {...b,evidenceDigest:digest(canonical(b))};}
test('three real-source observations never imply synchronization or eight viewers',()=>{
  const r=validateActualIphone(seal(fixture()));assert.equal(r.metrics.length,3);assert.equal(r.avSyncMeasured,false);assert.equal(r.fullTaskAccepted,false);
});
test('failed and tampered evidence rejected',()=>{const r=fixture();r.status='failed';assert.throws(()=>validateActualIphone(seal(r)));r.status='passed';const s=seal(r);s.cycles[0].decodedFrames++;assert.throws(()=>validateActualIphone(s));});
test('silent or short observation rejected',()=>{for(const kind of ['silent','short']){const r=fixture();if(kind==='silent')r.cycles[0].audioEnergyDelta=0;else r.cycles[0].samples.at(-1).at=r.cycles[0].samples[0].at;assert.throws(()=>validateActualIphone(seal(r)));}});
test('stale frame and incomplete cleanup rejected',()=>{for(const kind of ['frame','cleanup']){const r=fixture();if(kind==='frame')Object.assign(r.cycles[0].stoppedSample.video,{hidden:false,hasStream:true});else r.cleanup.sessionStopped=false;assert.throws(()=>validateActualIphone(seal(r)));}});
test('budgets and claim boundary cannot be relaxed',()=>{for(const kind of ['budget','claim']){const r=fixture();if(kind==='budget')r.budgets={...BUDGETS,maximumAudioConcealmentFraction:1};else r.avSyncMeasured=true;assert.throws(()=>validateActualIphone(seal(r)));}});
test('invalid dimensions, counters and sample clock are rejected',()=>{
  for(const kind of ['dimensions','counter','clock']){const r=fixture(),s=r.cycles[0].samples[1];
    if(kind==='dimensions')s.video.width=0.5;
    else if(kind==='counter')s.rtp[0].framesDecoded=-1;
    else s.at=r.cycles[0].samples[0].at;
    assert.throws(()=>validateActualIphone(seal(r)));
  }
});

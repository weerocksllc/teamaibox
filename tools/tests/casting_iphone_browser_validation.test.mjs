import assert from 'node:assert/strict';
import test from 'node:test';
import {canonical,digest,validateMediaObservation} from '../validate_casting_iphone_browser.mjs';
function fixture(){
  return {runId:'casting-iphone-browser-20260910-a999',status:'passed',systemTrustBrowser:true,certificateChecksDisabled:false,
    privacy:{mediaContentRetained:false,pairingCredentialsRetained:false,socialActionsPerformed:false},
    scope:{fullTask22Accepted:false,eightViewersTested:false,endToEndSyncMeasured:false,manualConnectionAudioVideoOnly:true},
    initiatorAutoJoined:true,phoneTransport:'user-operated',budgets:{cycles:1,sampleDurationMs:20000},
    cleanup:{ownedSessionStopped:true,signedOut:true},cycles:[{sourceStopTested:false,videoReadyMilliseconds:1000,
      decodedFrames:600,audioPackets:1000,audioEnergyDelta:10,
      samples:Array.from({length:11},(_,i)=>({observedAt:new Date(1789000000000+i*2000).toISOString(),
        video:{width:498,height:1080,hasStream:true,hidden:false,paused:false},
        rtp:[{kind:'video',framesDecoded:i*60},{kind:'audio',packetsReceived:i*100,totalAudioEnergy:i,
          totalSamplesReceived:1000+i*96000,concealedSamples:i*96}]}))}]};
}
function seal(v){const {evidenceDigest,...body}=v;return {...body,evidenceDigest:digest(canonical(body))};}
test('received-media check reports compensation without claiming sync or continuity',()=>{
  const result=validateMediaObservation(seal(fixture()));
  assert.equal(result.metrics[0].audioConcealedSampleFraction,0.001);
  assert.equal(result.endToEndSyncMeasured,false);assert.equal(result.audioContinuityQualified,false);
});
test('tampered evidence rejected',()=>{const v=seal(fixture());v.cycles[0].decodedFrames++;assert.throws(()=>validateMediaObservation(v),/digest/);});
test('failed run cannot pass even if counters look healthy',()=>{const v=fixture();v.status='failed';assert.throws(()=>validateMediaObservation(seal(v)),/run_not_passed/);});
test('silent data rejected',()=>{const v=fixture();for(const s of v.cycles[0].samples)s.rtp[1].totalAudioEnergy=0;v.cycles[0].audioEnergyDelta=0;assert.throws(()=>validateMediaObservation(seal(v)),/audio_not_audible_data/);});
test('cleanup and TLS bypass cannot be waived',()=>{for(const key of ['cleanup','tls']){const v=fixture();if(key==='tls')v.certificateChecksDisabled=true;else v.cleanup.ownedSessionStopped=false;assert.throws(()=>validateMediaObservation(seal(v)));}});
test('insufficient observation duration rejected',()=>{const v=fixture();v.cycles[0].samples.at(-1).observedAt=v.cycles[0].samples[0].observedAt;assert.throws(()=>validateMediaObservation(seal(v)),/sample_interval_invalid/);});

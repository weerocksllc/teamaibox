import assert from 'node:assert/strict';
import {canonical,digest} from './browser_smoke_common.mjs';
export const BUDGETS={cycles:3,sampleDurationMs:20000,sourceVideoDeadlineMs:45000,sourceStopDeadlineMs:8000,
  minimumDecodedFrames:300,minimumAudioPackets:500,maximumAudioConcealmentFraction:0.02};
const count=(s,kind,key)=>s.rtp.filter(r=>r.kind===kind).reduce((a,r)=>a+(r[key]||0),0);
export function validateActualIphone(r){
  const {evidenceDigest,...body}=r;assert.equal(digest(canonical(body)),evidenceDigest,'record_digest_changed');
  assert.equal(r.status,'passed','run_failed');assert.match(r.runId,/^casting-actual-iphone-\d{8}-a[1-9]\d*$/);
  assert.deepEqual(r.budgets,BUDGETS,'budget_changed');assert.equal(r.systemTrustBrowser,true);
  assert(r.certificates.length>0);assert(r.certificates.every(c=>['TLS 1.2','TLS 1.3'].includes(c.protocol)));
  for(const key of ['userMediaRetained','pairingCredentialsRetained','eightViewerMediaAccepted','glassToGlassLatencyMeasured','avSyncMeasured','fullTaskAccepted'])assert.equal(r[key],false,'claim_expanded');
  assert.equal(r.source.content,'dedicated-pattern-and-660Hz-tone');assert.equal(r.initiatorAutomaticallyJoined,true);
  assert.deepEqual(r.cleanup,{sourceStopped:true,sessionStopped:true,signedOut:true});
  assert.equal(r.cycles.length,BUDGETS.cycles);const metrics=[];
  for(const [index,c] of r.cycles.entries()){
    assert.equal(c.number,index+1);assert.equal(c.samples.length,11);
    assert(c.videoReadyMs>=0&&c.videoReadyMs<=BUDGETS.sourceVideoDeadlineMs);
    let previousTime=-Infinity;
    for(const s of c.samples){
      const sampleTime=Date.parse(s.at);assert(Number.isFinite(sampleTime)&&sampleTime>previousTime,'sample_clock_invalid');previousTime=sampleTime;
      assert(Number.isInteger(s.video.width)&&Number.isInteger(s.video.height)&&s.video.width>0&&s.video.height>0&&s.video.hasStream&&!s.video.hidden&&!s.video.paused);
      for(const row of s.rtp)for(const [key,value] of Object.entries(row))if(key!=='kind')assert(typeof value==='number'&&Number.isFinite(value)&&value>=0,'invalid_media_counter');
      assert(s.rtp.some(v=>v.kind==='video')&&s.rtp.some(v=>v.kind==='audio'));}
    const first=c.samples[0],last=c.samples.at(-1),duration=Date.parse(last.at)-Date.parse(first.at);
    assert(duration>=BUDGETS.sampleDurationMs&&duration<=30000,'sample_duration_invalid');
    const delta=(kind,key)=>count(last,kind,key)-count(first,kind,key);
    const frames=delta('video','framesDecoded'),packets=delta('audio','packetsReceived'),energy=delta('audio','totalAudioEnergy');
    assert.equal(c.decodedFrames,frames);assert(frames>=BUDGETS.minimumDecodedFrames);
    assert.equal(c.audioPackets,packets);assert(packets>=BUDGETS.minimumAudioPackets);
    assert.equal(c.audioEnergyDelta,energy);assert(energy>0,'silent_audio');
    const received=delta('audio','totalSamplesReceived'),concealed=delta('audio','concealedSamples');
    assert(received>0&&concealed>=0&&concealed<=received);assert.equal(c.audioConcealmentFraction,concealed/received);
    assert(c.audioConcealmentFraction<=BUDGETS.maximumAudioConcealmentFraction,'audio_continuity_failed');
    assert(c.sourceStopFeedbackMs>=0&&c.sourceStopFeedbackMs<=BUDGETS.sourceStopDeadlineMs);
    assert(c.stoppedSample.sourceEnded&&c.stoppedSample.sourceFeedbackVisible&&(!c.stoppedSample.video.hasStream||c.stoppedSample.video.hidden),'stale_picture');
    if(index===1)assert(c.reloadVideoReadyMs>=0&&c.reloadVideoReadyMs<=BUDGETS.sourceVideoDeadlineMs);
    metrics.push({cycle:c.number,durationMs:duration,decodedFrames:frames,framesPerSecond:frames*1000/duration,
      audioPackets:packets,audioConcealmentFraction:c.audioConcealmentFraction,sourceStopFeedbackMs:c.sourceStopFeedbackMs,
      resolutions:[...new Set(c.samples.map(s=>s.video.width+'x'+s.video.height))]});
  }
  return {status:'passed',strictVerified:true,metrics,avSyncMeasured:false,glassToGlassLatencyMeasured:false,fullTaskAccepted:false};
}

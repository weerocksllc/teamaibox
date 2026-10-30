// Independent, deliberately narrow validation: received media is not an A/V-sync certificate.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const sources=['tools/test_casting_iphone_browser.mjs','tools/ios-casting-probe/Tests/CastingDeviceProbe.swift',
  'apps/wireless-casting-plugin/src/public/app.js','apps/wireless-casting-plugin/src/public/casting-media-client-v1.mjs'];
export const canonical=value=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`
  :value&&typeof value==='object'?`{${Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')}}`:JSON.stringify(value);
export const digest=value=>'sha256:'+createHash('sha256').update(value).digest('hex');
const total=(sample,kind,key)=>sample.rtp.filter(r=>r.kind===kind).reduce((a,r)=>a+(r[key]??0),0);
export function validateMediaObservation(report){
  const {evidenceDigest,...body}=report;
  assert.equal(digest(canonical(body)),evidenceDigest,'evidence_digest_mismatch');
  assert.equal(report.status,'passed','run_not_passed');
  assert.match(report.runId,/^casting-iphone-browser-20260910-a[1-9][0-9]*$/);
  assert.equal(report.systemTrustBrowser,true);assert.equal(report.certificateChecksDisabled,false);
  assert.equal(report.privacy.mediaContentRetained,false);assert.equal(report.privacy.pairingCredentialsRetained,false);
  assert.equal(report.privacy.socialActionsPerformed,false);
  assert.equal(report.scope.fullTask22Accepted,false);assert.equal(report.scope.eightViewersTested,false);
  assert.equal(report.scope.endToEndSyncMeasured,false);
  assert.equal(report.initiatorAutoJoined,true);
  assert.equal(report.cleanup.ownedSessionStopped,true);assert.equal(report.cleanup.signedOut,true);
  assert.equal(report.phoneTransport,'user-operated');assert.equal(report.scope.manualConnectionAudioVideoOnly,true);
  assert.equal(report.cycles.length,1);assert.equal(report.budgets.cycles,1);
  assert.equal(report.budgets.sampleDurationMs,20000);
  const metrics=report.cycles.map(cycle=>{
    assert.equal(cycle.sourceStopTested,false);assert(cycle.videoReadyMilliseconds>=0&&cycle.videoReadyMilliseconds<=300000);
    assert.equal(cycle.samples.length,11);
    for(const sample of cycle.samples){
      assert(sample.video.width>0&&sample.video.height>0&&sample.video.hasStream);
      assert.equal(sample.video.paused,false);assert.equal(sample.video.hidden,false);
      assert(sample.rtp.some(r=>r.kind==='audio')&&sample.rtp.some(r=>r.kind==='video'));
      assert(Number.isFinite(Date.parse(sample.observedAt)));
    }
    const first=cycle.samples[0],last=cycle.samples.at(-1);
    const elapsed=Date.parse(last.observedAt)-Date.parse(first.observedAt);
    assert(elapsed>=20000&&elapsed<=60000,'sample_interval_invalid');
    const delta=(kind,key)=>total(last,kind,key)-total(first,kind,key);
    const videoFrames=delta('video','framesDecoded'),audioPackets=delta('audio','packetsReceived'),energy=delta('audio','totalAudioEnergy');
    assert.equal(videoFrames,cycle.decodedFrames);assert(videoFrames>100);
    assert.equal(audioPackets,cycle.audioPackets);assert(audioPackets>100);
    assert.equal(energy,cycle.audioEnergyDelta);assert(energy>0,'audio_not_audible_data');
    const received=delta('audio','totalSamplesReceived'),concealed=delta('audio','concealedSamples');
    assert(received>0&&concealed>=0&&concealed<=received,'audio_counters_invalid');
    return {observedMilliseconds:elapsed,videoFrames,audioPackets,videoFramesPerSecond:videoFrames*1000/elapsed,
      audioConcealedSampleFraction:concealed/received,
      decodedResolutions:[...new Set(cycle.samples.map(s=>s.video.width+'x'+s.video.height))]};
  });
  return {runId:report.runId,status:'passed',claim:'actual_browser_audio_video_received',
    audioContinuityQualified:false,endToEndSyncMeasured:false,fullTask22Accepted:false,metrics};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  assert.equal(process.argv[2],'--evidence');const path=resolve(process.argv[3]);
  const report=JSON.parse(await readFile(path,'utf8'));
  assert.equal(path,resolve(root,'evidence/validation/browser/'+report.runId+'.json'));
  const result=validateMediaObservation(report);
  assert.deepEqual(Object.keys(report.sources).sort(),[...sources].sort());
  for(const path of sources)assert.equal(digest(await readFile(resolve(root,path))),report.sources[path],'source_drift:'+path);
  console.log(JSON.stringify({...result,evidenceDigest:report.evidenceDigest}));
}

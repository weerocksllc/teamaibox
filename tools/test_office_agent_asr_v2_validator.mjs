import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateReport} from './validate_current_office_agent_asr_browser_v2.mjs';
import {canonical,digest} from './validate_casting_iphone_browser.mjs';
// Historical report used only as an in-memory test fixture, never saved as evidence.
const old=JSON.parse(await readFile(new URL('../evidence/validation/acceptance/office-agent-asr-20260916-a5.json',import.meta.url)));
function fixture(){
 const r=structuredClone(old);r.runId='office-agent-asr-20260924-a1';
 for(const s of [r.before,...r.samples,r.after]){
  s.workers=s.workers.filter(w=>w.name!=='teamaibox-protected-office-ocr-provider-v1');
  s.ocrRoute={workerId:'b3ea0138-4acf-5840-ad1d-5b698cc89cf5',origin:'http://teamaibox-worker-b3ea0138-4acf-5840-ad1d-5b698cc89cf5:8000',protocol:'hunyuan-managed-v1',model:'hunyuanocr-1.5-bf16-dflash'};
 }
 return r;
}
function signed(r){delete r.evidenceDigest;r.evidenceDigest=digest(canonical(r));return r;}
test('current six-worker report is accepted',()=>validateReport(signed(fixture())));
for(const [name,change] of [
 ['missing worker',r=>r.samples[0].workers.pop()],
 ['worker restart',r=>r.samples[0].workers[0].startedAt='changed'],
 ['swap use',r=>r.samples[0].swapUsedBytes=1],
 ['active casting',r=>r.samples[0].activeCastSessions=1],
 ['OCR dependency change',r=>r.samples[0].ocrRoute.origin='http://legacy-adapter'],
 ['ASR wrong result',r=>r.asr.expectedTextMatched=false],
 ['Agent missing artifact',r=>r.agent.artifactMatched=false],
 ['cleanup failure',r=>r.cleanup.ownedReferenceRevoked=false],
 ['overclaim',r=>r.scope.fullOfficeSetAccepted=true],
 ['certificate bypass',r=>r.certificateChecksDisabled=true]
])test('reject '+name,()=>{const r=fixture();change(r);assert.throws(()=>validateReport(signed(r)));});

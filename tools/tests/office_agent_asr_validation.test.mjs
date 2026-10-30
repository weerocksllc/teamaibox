import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {validateReport} from '../validate_office_agent_asr_browser.mjs';
import {canonical,digest} from '../validate_casting_iphone_browser.mjs';
const original=JSON.parse(await readFile(new URL('../../evidence/validation/acceptance/office-agent-asr-20260910-a2.json',import.meta.url),'utf8'));
const copy=()=>structuredClone(original);
function reseal(v){delete v.evidenceDigest;v.evidenceDigest=digest(canonical(v));return v;}
test('exact completed report validates without claiming full-office acceptance',()=>validateReport(copy()));
test('tampering is rejected',()=>{const v=copy();v.agent.artifactMatched=false;assert.throws(()=>validateReport(v));});
test('false positive transcript or mismatched profile is rejected',()=>{for(const key of ['expectedTextMatched','profileId']){const v=copy();v.asr[key]=key==='profileId'?'other':false;assert.throws(()=>validateReport(reseal(v)));}});
test('Agent must actually write, be approved and return matching artifact',()=>{for(const key of ['confirmationApproved','artifactMatched','successfulTools']){const v=copy();v.agent[key]=key==='successfulTools'?[]:false;assert.throws(()=>validateReport(reseal(v)));}});
test('memory, identity and cleanup regressions are rejected',()=>{for(const key of ['memory','identity','cleanup']){const v=copy();if(key==='memory')v.samples[0].swapUsedBytes=4096;else if(key==='identity')v.after.workers[0].id='different';else v.cleanup.signedOut=false;assert.throws(()=>validateReport(reseal(v)));}});

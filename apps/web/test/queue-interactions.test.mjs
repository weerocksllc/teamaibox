import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {editableKeys, policyInput, preservePolicyBaseline} from '../src/queues/queue-policy-draft.ts';

test('refresh updates counts but keeps the original policy revision while editing',()=>{
  const current={policy:{revision:13,maxQueuedPerOwner:64},summary:{activeJobs:1}};
  const next={policy:{revision:14,maxQueuedPerOwner:128},summary:{activeJobs:2}};
  const kept=preservePolicyBaseline(next,current,true);
  assert.equal(kept.policy,current.policy);
  assert.equal(kept.summary,next.summary);
  assert.equal(kept.policy.revision,13);
  assert.equal(preservePolicyBaseline(next,current,false),next);
  assert.equal(preservePolicyBaseline(next,null,true),next);
});

test('discard and save acknowledgement use only editable fields from the latest policy',()=>{
  const policy={revision:14,updatedBy:'other-admin',...Object.fromEntries(editableKeys.map(key=>[key,9]))};
  assert.deepEqual(Object.keys(policyInput(policy)),editableKeys);
  assert.equal(policyInput(policy).maxQueuedPerOwner,9);
  assert.equal(policyInput(policy).revision,undefined);
});

const source=readFileSync(new URL('../src/queues/QueueAdministrationPanel.tsx',import.meta.url),'utf8');
test('loading and errors keep the existing editor mounted and preserve failed edits',()=>{
  assert.match(source,/\{data && draft && <>/);
  assert.doesNotMatch(source,/state === "ready" && data/);
  assert.match(source,/if \(refreshing.current\) return/);
  assert.match(source,/latestPolicy.current = value.policy/);
  assert.match(source,/await refresh\(true, true\)/);
  assert.match(source,/onClick=\{discard\}/);
});

test('cancel confirmation traps focus, handles Escape, and cannot close while submitting',()=>{
  assert.match(source,/containModalFocus\(cancelPanel.current\)/);
  assert.match(source,/event.stopPropagation\(\); if \(!busy\)/);
  assert.match(source,/secondary-button" disabled=\{busy !== null\} onClick=\{\(\) => \{ setCancelJob/);
  assert.doesNotMatch(source,/<input autoFocus/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeModelChoice} from '../src/assistant/native-model.ts';
test('compaction uses the effective default, including namespaced model IDs',()=>{
  assert.deepEqual(nativeModelChoice('','teamaibox/agent.default'),{providerID:'teamaibox',modelID:'agent.default'});
  assert.deepEqual(nativeModelChoice('','explicit/team/model'),{providerID:'explicit',modelID:'team/model'});
});
test('an explicit UI choice wins, and a missing default never selects an unrelated provider',()=>{
  assert.deepEqual(nativeModelChoice('selected\nmodel','teamaibox/agent.default'),{providerID:'selected',modelID:'model'});
  for(const value of [undefined,'','invalid','/model','provider/'])assert.throws(()=>nativeModelChoice('',value));
});

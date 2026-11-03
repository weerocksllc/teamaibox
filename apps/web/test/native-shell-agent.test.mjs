import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeShellAgent} from '../src/assistant/native-shell-agent.ts';

test('shell honors explicit and configured agents without choosing catalog order',()=>{
  const agents=[{name:'alpha',mode:'primary'},{name:'build',mode:'primary'}];
  assert.equal(nativeShellAgent('alpha','build',agents),'alpha');
  assert.equal(nativeShellAgent('','alpha',agents),'alpha');
  assert.equal(nativeShellAgent('',undefined,agents),'build');
});
test('shell refuses ambiguous custom defaults instead of silently changing agent',()=>{
  assert.equal(nativeShellAgent('',undefined,[{name:'build',hidden:true},{name:'general',mode:'subagent'},{name:'only',mode:'primary'}]),'only');
  assert.throws(()=>nativeShellAgent('',undefined,[{name:'alpha',mode:'primary'},{name:'plan',mode:'primary'}]),/native_shell_select_agent/);
  assert.throws(()=>nativeShellAgent('',undefined,[]),/native_shell_select_agent/);
});

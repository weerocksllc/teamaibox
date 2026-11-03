import test from 'node:test';
import assert from 'node:assert/strict';
import {validateNativeConfig} from '../src/assistant/native-config-validation.ts';

test('native schema accepts supported configuration and JSONC without changing source',()=>{
  const source='// retained comment\n{"model":"synthetic/example","command":{"test":{"template":"hello"}},"mcp":{"test":{"type":"local","command":["node","mcp.mjs"]}},}\n';
  assert.equal(validateNativeConfig(source,true).model,'synthetic/example');
  assert.equal(source.startsWith('// retained'),true);
  assert.deepEqual(validateNativeConfig('{"plugin":[["file:///workspace/plugin.mjs",{"enabled":true}]]}').plugin,[['file:///workspace/plugin.mjs',{enabled:true}]]);
});
test('native schema rejects invalid shapes before writing and does not echo secret values',()=>{
  for(const source of ['{"model":17}','[]','null','{"command":{"test":{"template":true}}}','{"mcp":{"test":{"type":"local","command":"node"}}}','{','{"model":"synthetic/example",}'])assert.throws(()=>validateNativeConfig(source));
  assert.throws(()=>validateNativeConfig('{"model":{"secret":"not-a-real-secret"}}'),error=>!error.message.includes('not-a-real-secret'));
  assert.throws(()=>validateNativeConfig('// comment\n{}'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {penpotRuntimeContext, withPenpotRuntimeConfig, penpotRuntimePaths, safePenpotConfiguration} from '../src/penpot-runtime-config.mjs';

const user='00000000-0000-4000-8000-000000000001';
const settings={enabled:true,transportRevision:'teamaibox-penpot-transport-2',platformOrigin:'http://platform-api:8080',mcpOrigin:'http://penpot-mcp:4401'};
test('invalid optional design settings fail closed without changing ordinary Agent settings',()=>{
  const diagnostics=[];
  assert.equal(safePenpotConfiguration(undefined),undefined);
  assert.deepEqual(safePenpotConfiguration(settings),settings);
  const value=safePenpotConfiguration({...settings,mcpOrigin:'http://private-user:private-secret@example.invalid'},code=>diagnostics.push(code));
  assert.deepEqual(value,{enabled:false});assert.deepEqual(diagnostics,['penpot_runtime_configuration_invalid']);
  const original={mcp:{preserved:{enabled:false}},skills:{paths:['/workspace/skills']},model:'synthetic/choice'};
  assert.deepEqual(withPenpotRuntimeConfig(original,penpotRuntimeContext(user,value)),{...original,plugin:[penpotRuntimePaths.plugin]});
});
test('design managed defaults preserve other MCP, plugins, skills, permissions and model choice',()=>{
  const config={mcp:{example:{type:'remote',url:'https://example.invalid/mcp',enabled:false}},plugin:['file:///workspace/example.mjs'],
    skills:{paths:['/workspace/skills']},model:'example/selected',permission:{'*':'ask'}};
  const before=structuredClone(config),context=penpotRuntimeContext(user,settings),result=withPenpotRuntimeConfig(config,context);
  assert.deepEqual(config,before);
  assert.deepEqual(result.mcp.example,before.mcp.example);
  for(const key of ['skills','model','permission'])assert.deepEqual(result[key],before[key]);
  assert.deepEqual(result.plugin,[...before.plugin,penpotRuntimePaths.plugin]);
  assert.deepEqual(result.mcp[penpotRuntimePaths.entry],{type:'remote',url:penpotRuntimePaths.endpoint,enabled:true,oauth:false});
  assert.equal(JSON.stringify(result).includes(user),false);
  assert.equal(JSON.stringify(result).includes('Bearer'),false);
  assert.deepEqual(withPenpotRuntimeConfig(config,penpotRuntimeContext(user,{enabled:false})),{...config,plugin:[...config.plugin,penpotRuntimePaths.plugin]});
});
test('only validated operator origins and patched transport can enable a per-user context',()=>{
  for(const key of ['mcpOrigin','platformOrigin'])for(const origin of ['https://u:p@example.invalid','https://example.invalid/path','file:///tmp/x','http://example.invalid/?token=x']){
    assert.throws(()=>penpotRuntimeContext(user,{...settings,[key]:origin}));
  }
  assert.throws(()=>penpotRuntimeContext(user,{...settings,transportRevision:'upstream'}));
  assert.throws(()=>penpotRuntimeContext('../user',settings));
  assert.throws(()=>withPenpotRuntimeConfig({mcp:{'teamaibox-penpot':{}}},{enabled:true}));
  assert.notEqual(penpotRuntimeContext(user,settings).identityId,penpotRuntimeContext('00000000-0000-4000-8000-000000000002',settings).identityId);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {AssistantService} from '../src/assistant/assistant-service.mjs';
import {MemoryAssistantRepository} from '../src/assistant/memory-repository.mjs';
import {AgentSessionService} from '../../../services/agent-bridge/src/agent-session-service.mjs';
import {MemoryAgentSessionRepository} from '../../../services/agent-bridge/src/memory-session-repository.mjs';

test('legacy history exposes only an existing owned binding without replaying or creating one',async()=>{
  const owner=randomUUID(),other=randomUUID();let executions=0;
  const nativeSessions=new AgentSessionService({repository:new MemoryAgentSessionRepository()});
  const runner={run:async()=>{executions++;throw Error('History cannot execute');}};
  const service=new AssistantService({repository:new MemoryAssistantRepository(),nativeSessions,answerRunner:runner,agentRunner:runner});
  const legacy=await service.createConversation(owner,{title:'Synthetic history'});
  assert.equal((await service.getConversation(owner,legacy.id)).nativeSession,null);
  await nativeSessions.bindConversation({ownerIdentityId:owner,platformConversationId:legacy.id,workspaceKey:'workspace.synthetic',sandboxKey:'sandbox.synthetic',adapterKey:'opencode.1.18',upstreamVersion:'1.18.16',upstreamArtifactDigest:'sha256:'+'1'.repeat(64),opencodeSessionId:'ses_synthetic'});
  const result=await service.getConversation(owner,legacy.id);
  assert.deepEqual(result.nativeSession,{id:'ses_synthetic',directory:'/workspace'});
  assert.deepEqual(result.messages,[]);assert.equal(result.title,'Synthetic history');assert.equal(executions,0);
  await assert.rejects(service.getConversation(other,legacy.id));
  assert.equal(executions,0);
});

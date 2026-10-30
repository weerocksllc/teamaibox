/** Signed read-only inspection. Never opens a new node observation window. */
import { readFile } from 'node:fs/promises';
import { createPostgresDatabaseFromEnvironment } from '/opt/teamaibox/packages/persistence/src/postgres-database.mjs';
import { ManagedNodeAgentRouter } from '/opt/teamaibox/services/scheduler/src/managed-node-agent-router.mjs';
import { PostgresManagedNodeRepository } from '/opt/teamaibox/services/scheduler/src/postgres-managed-node-repository.mjs';
import { ProtectedNodeAgentClient } from '/opt/teamaibox/services/scheduler/src/protected-node-agent-client.mjs';
import { NodeAgentHttpsTransport } from '/opt/teamaibox/services/scheduler/src/node-agent-https-transport.mjs';
import { HmacNodeAgentCommandSigner } from '/opt/teamaibox/services/scheduler/src/node-agent-command-signer.mjs';
import { NodeAgentWorkerSpecFactory } from '/opt/teamaibox/services/scheduler/src/node-agent-worker-spec-factory.mjs';

let database;
const secrets=[];
try {
  const request=JSON.parse(process.argv[2]);
  const localNodeId=process.env.PLATFORM_APPLIANCE_NODE_ID;
  if(request.nodeId!==localNodeId)throw Error('appliance_node_mismatch');
  if (!/^[a-f0-9-]{36}$/.test(request.nodeId) || !Number.isSafeInteger(request.nodeGeneration)
      || request.nodeGeneration<1 || !/^[a-z0-9-]{3,128}$/.test(request.runId)) throw Error('invalid_request');
  database=await createPostgresDatabaseFromEnvironment(process.env);
  await database.ready();
  const [ca,certificate,privateKey,encodedKey]=await Promise.all(['CA','CERT','KEY','COMMAND_KEY'].map(async key=>{
    const bytes=await readFile(process.env['PLATFORM_APPLIANCE_'+key+'_FILE']);
    secrets.push(bytes);return bytes;
  }));
  const encoded=encodedKey.toString('utf8').trim(),key=Buffer.from(encoded,'base64');secrets.push(key);
  if (key.length<32 || key.length>128 || key.toString('base64')!==encoded) throw Error('invalid_command_key');
  const router=new ManagedNodeAgentRouter({nodeRepository:new PostgresManagedNodeRepository({database,localNodeId}),localNodeId,connectorFactory:async route=>{
    const endpoint={host:process.env.PLATFORM_APPLIANCE_AGENT_HOST||'127.0.0.1',port:Number(process.env.PLATFORM_APPLIANCE_AGENT_PORT||9443)};
    if(!['localhost','127.0.0.1','::1'].includes(endpoint.host))throw Error('appliance_agent_not_local');
    if(!endpoint)throw Error('missing_endpoint');
    return new ProtectedNodeAgentClient({nodeId:route.nodeId,nodeGeneration:route.nodeGeneration,
      transport:new NodeAgentHttpsTransport({host:endpoint.host,port:endpoint.port,
        expectedServerName:route.expectedServerName,expectedCertificateFingerprint:route.expectedCertificateFingerprint,
        ca,certificate,privateKey}),
      commandSigner:new HmacNodeAgentCommandSigner({keyId:process.env.PLATFORM_APPLIANCE_COMMAND_KEY_ID || 'scheduler-persistent-v1',key}),
      workerSpecFactory:new NodeAgentWorkerSpecFactory()});
  }});
  const identity=await router.inspectAppliance({nodeId:request.nodeId,nodeGeneration:request.nodeGeneration,correlationId:request.runId});
  console.log(JSON.stringify({status:'passed',identity,observationWindowReset:false,workloadsMutated:false}));
} catch(error) {
  console.log(JSON.stringify({status:'failed',code:/^[a-z0-9_:-]{1,96}$/.test(error.code ?? '') ? error.code : 'appliance_inspection_failed'}));
  process.exitCode=1;
} finally {
  for(const bytes of secrets)bytes.fill(0);
  await database?.close();
}

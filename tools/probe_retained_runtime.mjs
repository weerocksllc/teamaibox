// Run inside the installed API. Only health and static application GETs; no
// model generation, guest start/stop, credential output or content retention.
import {readFile} from 'node:fs/promises';
import {NodeAgentHttpsTransport} from '../services/scheduler/src/node-agent-https-transport.mjs';
import {HmacNodeAgentCommandSigner} from '../services/scheduler/src/node-agent-command-signer.mjs';
import {ProtectedNodeAgentClient} from '../services/scheduler/src/protected-node-agent-client.mjs';
import {NodeAgentWorkerSpecFactory} from '../services/scheduler/src/node-agent-worker-spec-factory.mjs';
import {resolveNodeAgentCertificateFingerprint} from '../apps/platform-api/server/plugin-runtime.mjs';
export async function probe(workers,generation,env=process.env) {
 const cfg=JSON.parse(await readFile(env.PLATFORM_PLUGIN_RUNTIME_CONFIG_FILE));
 const load=name=>readFile(env['PLATFORM_PLUGIN_NODE_AGENT_'+name+'_FILE']);
 const [ca,certificate,privateKey,encoded]=await Promise.all(['CA','CLIENT_CERT','CLIENT_KEY','COMMAND_KEY'].map(load));
 const key=Buffer.from(encoded.toString().trim(),'base64');encoded.fill(0);
 let client,oldClient;try {
  const make=g=>new ProtectedNodeAgentClient({nodeId:cfg.node.nodeId,nodeGeneration:g,allowRetainedRuntime:true,
   transport:new NodeAgentHttpsTransport({...cfg.node,expectedCertificateFingerprint:awaitablePin,ca,certificate,privateKey}),
   commandSigner:new HmacNodeAgentCommandSigner({keyId:cfg.node.commandKeyId,key}),workerSpecFactory:new NodeAgentWorkerSpecFactory()});
  const awaitablePin=await resolveNodeAgentCertificateFingerprint({configured:cfg.node.expectedCertificateFingerprint,path:env.PLATFORM_PLUGIN_NODE_AGENT_FINGERPRINT_FILE});
  client=make(generation);oldClient=make(generation-1);const results=[];
  for(const worker of workers) {
   const input={workerId:worker.workerId,authority:{nodeGeneration:worker.generation,leaseId:worker.leaseId,fencingToken:worker.fencingToken},correlationId:'retained-runtime:probe'};
   const state=await client.workerHealth(input);
   if(state.containerId!==worker.containerId||state.status!=='running'||!['healthy','not_configured'].includes(state.health))throw Error('retained_identity_changed');
   const value={workerId:worker.workerId,containerId:state.containerId,health:state.health};
   if(worker.path){const page=await client.fetchApplication({...input,method:'GET',path:worker.path});if(page.status!==200||!page.body.length)throw Error('application_fetch_failed');value.application={status:page.status,bytes:page.body.length};}
   results.push(value);
  }
  let staleRejected=false;try{await oldClient.workerHealth({workerId:workers[0].workerId,authority:{nodeGeneration:generation-1,leaseId:workers[0].leaseId,fencingToken:workers[0].fencingToken},correlationId:'retained-runtime:old-envelope'});}catch(e){staleRejected=e.code==='stale_node_generation';}
  if(!staleRejected)throw Error('stale_envelope_not_rejected');
  return {generation,results,staleEnvelopeRejected:staleRejected};
 }finally{client?.close();oldClient?.close();for(const b of [ca,certificate,privateKey,key])b.fill(0);}
}

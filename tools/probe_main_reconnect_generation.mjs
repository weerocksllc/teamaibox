// Read-only diagnostic. Run inside the live API; no credentials are exported.
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {NodeAgentHttpsTransport} from '../services/scheduler/src/node-agent-https-transport.mjs';
import {HmacNodeAgentCommandSigner} from '../services/scheduler/src/node-agent-command-signer.mjs';
import {resolveNodeAgentCertificateFingerprint} from '../apps/platform-api/server/plugin-runtime.mjs';

export async function probe(worker,env=process.env) {
  const cfg=JSON.parse(await readFile(env.PLATFORM_PLUGIN_RUNTIME_CONFIG_FILE));
  const load=name=>readFile(env['PLATFORM_PLUGIN_NODE_AGENT_'+name+'_FILE']);
  const [ca,certificate,privateKey,encoded]=await Promise.all(['CA','CLIENT_CERT','CLIENT_KEY','COMMAND_KEY'].map(load));
  const key=Buffer.from(encoded.toString().trim(),'base64');encoded.fill(0);
  let transport,signer;
  try {
    transport=new NodeAgentHttpsTransport({...cfg.node,
      expectedCertificateFingerprint:await resolveNodeAgentCertificateFingerprint({configured:cfg.node.expectedCertificateFingerprint,
        path:env.PLATFORM_PLUGIN_NODE_AGENT_FINGERPRINT_FILE}),ca,certificate,privateKey});
    signer=new HmacNodeAgentCommandSigner({keyId:cfg.node.commandKeyId,key});
    const commandId=randomUUID(),now=Date.now();
    const envelope={protocolVersion:1,commandId,nodeId:cfg.node.nodeId,nodeGeneration:cfg.node.nodeGeneration,
      type:'worker.health',issuedAt:new Date(now).toISOString(),deadlineAt:new Date(now+10000).toISOString(),
      correlationId:'main-reconnect-generation-diagnostic',leaseId:worker.leaseId,fencingToken:worker.fencingToken,
      idempotency:'keyed',payload:{workerId:worker.workerId}};
    const body=JSON.stringify(envelope),proof=await signer.sign({body,commandId,deadlineAt:envelope.deadlineAt});
    const response=await transport.postCommand({path:'/v1/commands',body,headers:{'content-type':'application/json',
      'x-teamaibox-key-id':proof.keyId,'x-teamaibox-nonce':proof.nonce,'x-teamaibox-signature':proof.signature}});
    return {configuredGeneration:cfg.node.nodeGeneration,status:response.status,errorCode:response.errorCode??null,
      responseGeneration:response.nodeGeneration};
  } catch(error) {return {configuredGeneration:cfg.node.nodeGeneration,errorCode:error.code??error.name};}
  finally {transport?.close();signer?.close();for(const b of [ca,certificate,privateKey,key])b.fill(0);}
}

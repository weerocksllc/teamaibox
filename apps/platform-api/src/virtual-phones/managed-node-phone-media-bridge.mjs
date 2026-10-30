import {phoneApprovedNodes} from "../../../../services/scheduler/src/phone-approved-nodes.mjs";
import {installedPhoneRuntime} from "../../../../services/scheduler/src/phone-rom.mjs";
import {validatePhoneMediaCommand,validatePhoneMediaResult} from "../../../../services/scheduler/src/android-phone-media-command.mjs";
import {failPhone,identifier,PHONE_SPEC} from "./contracts.mjs";
import WebSocket from "ws";

/** Resolve content routes from durable phone/run facts. Browser requests can
 * provide a grant ID, never a node address, socket path, certificate or port. */
export class PostgresPhoneMediaRoutes {
  #database;#nodes;
  constructor({database,approvedNodes}) {
    if(typeof database?.query!=="function")throw TypeError("Phone media requires PostgreSQL");
    this.#database=database;this.#nodes=phoneApprovedNodes(approvedNodes);
  }
  async resolve(grant,action) {
    for(const key of ["id","phoneId","ownerId","runId","sessionId"])identifier(grant?.[key]);
    if(!["control","adb"].includes(grant.kind) || !Number.isSafeInteger(grant.generation) || grant.generation<1)failPhone("phone_grant_invalid");
    const {rows}=await this.#database.query(`SELECT p.id,p.owner_id,p.volume_id,p.pool_id,p.base_build_id,p.spec_id,p.storage_bytes,
      p.generation,p.node_id,p.state,p.rom_version_id,v.runtime_image_digest,r.id AS run_id,r.node_generation,r.image_digest,r.memory_bytes,r.cpu_millis,r.reservation_id,r.state AS run_state
      FROM platform.phones p JOIN platform.phone_rom_versions v ON v.id=p.rom_version_id JOIN platform.phone_runs r ON r.phone_id=p.id AND r.owner_id=p.owner_id
      WHERE p.id=$1 AND p.owner_id=$2 AND r.id=$3 AND p.generation=$4 AND r.generation=$4 AND p.state<>'deleted'`,
    [grant.phoneId,grant.ownerId,grant.runId,grant.generation]);
    if(rows.length!==1)failPhone("phone_stale_run");
    const row=rows[0],node=this.#nodes.get(row.node_id);
    const installed=installedPhoneRuntime(node,{id:row.id,ownerId:row.owner_id,volumeId:row.volume_id,
      romVersionId:row.rom_version_id,rom:{imageDigest:row.runtime_image_digest}},row.image_digest);
    if(!node || !installed || node.poolId!==row.pool_id || installed.imageDigest!==row.image_digest || !Number.isSafeInteger(Number(row.node_generation)) || Number(row.node_generation)<node.nodeGeneration)failPhone("phone_node_unavailable");
    if(row.id!==grant.phoneId || row.owner_id!==grant.ownerId || row.run_id!==grant.runId || Number(row.generation)!==grant.generation
      || row.base_build_id!==PHONE_SPEC.buildId || row.spec_id!==PHONE_SPEC.id || Number(row.storage_bytes)!==PHONE_SPEC.storageBytes
      || Number(row.memory_bytes)!==PHONE_SPEC.memoryBytes || Number(row.cpu_millis)!==PHONE_SPEC.cpuMillis
      || action!=="close" && (row.state!=="running" || row.run_state!=="running"))failPhone("phone_stale_run");
    return {nodeId:node.nodeId,nodeGeneration:Number(row.node_generation),payload:{phoneId:grant.phoneId,ownerId:grant.ownerId,
      volumeId:identifier(row.volume_id),poolId:row.pool_id,baseBuildId:row.base_build_id,operationId:grant.id,generation:grant.generation,
      run:{id:grant.runId,reservationId:identifier(row.reservation_id),imageDigest:row.image_digest,memoryBytes:PHONE_SPEC.memoryBytes,cpuMillis:PHONE_SPEC.cpuMillis},
      grantId:grant.id,sessionId:grant.sessionId,kind:grant.kind}};
  }
}

export class ManagedNodePhoneMediaBridge {
  maximumLeaseMilliseconds=5000;
  #routes;#router;
  constructor({routes,nodeAgentRouter}) {
    if(typeof routes?.resolve!=="function" || typeof nodeAgentRouter?.executePhoneMedia!=="function")throw TypeError("Phone media bridge is incomplete");
    this.#routes=routes;this.#router=nodeAgentRouter;
  }
  async #execute(action,grant,leaseExpiresAt) {
    const selected=await this.#routes.resolve(grant,action);
    const payload=validatePhoneMediaCommand(action,{...selected.payload,...(action==="close"?{}:{leaseExpiresAt})});
    const result=await this.#router.executePhoneMedia({...selected,action,payload,correlationId:`phone-media:${grant.id}`});
    return validatePhoneMediaResult(action,payload,result);
  }
  open({grant,leaseExpiresAt}){return this.#execute("open",grant,leaseExpiresAt);}
  renew({grant,leaseExpiresAt}){return this.#execute("renew",grant,leaseExpiresAt);}
  close(grant){return this.#execute("close",grant);}
}

export class ManagedNodePhoneSignallingUpstream {
  #routes;#router;
  constructor({routes,nodeAgentRouter}) {
    if(typeof routes?.resolve!=="function" || typeof nodeAgentRouter?.connectPhoneSignal!=="function")throw TypeError("Phone signalling is incomplete");
    this.#routes=routes;this.#router=nodeAgentRouter;
  }
  async connect({grant,signal,onMessage,onClose}) {
    if(grant?.kind!=="control")failPhone("phone_grant_invalid");
    const selected=await this.#routes.resolve(grant,"renew"),payload=validatePhoneMediaCommand("renew",{...selected.payload,leaseExpiresAt:Date.now()+4000});
    return this.#router.connectPhoneSignal({...selected,payload,correlationId:`phone-signal:${grant.id}`,signal,onMessage,onClose,
      createWebSocket:(url,options)=>new WebSocket(url,options)});
  }
}

export class ManagedNodePhoneAdbUpstream {
  #routes;#router;
  constructor({routes,nodeAgentRouter}) {
    if(typeof routes?.resolve!=="function" || typeof nodeAgentRouter?.connectPhoneADB!=="function")throw TypeError("Phone debugging is incomplete");
    this.#routes=routes;this.#router=nodeAgentRouter;
  }
  async connect({grant,signal}) {
    if(grant?.kind!=="adb")failPhone("phone_grant_invalid");
    const selected=await this.#routes.resolve(grant,"renew"),payload=validatePhoneMediaCommand("renew",{...selected.payload,leaseExpiresAt:Date.now()+4000});
    return this.#router.connectPhoneADB({...selected,payload,correlationId:`phone-adb:${grant.id}`,signal});
  }
}

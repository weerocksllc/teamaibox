import { createHash, randomBytes } from "node:crypto";
import { failPhone, identifier, validateConnectionRequest } from "./contracts.mjs";

const bindingKeys=["id","phoneId","ownerId","runId","generation","sessionId","kind"];
const sameBinding=(a,b)=>bindingKeys.every(key=>a?.[key]===b[key]);
const tokenHash=value=>{
  if (typeof value!=="string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) failPhone("phone_grant_invalid");
  return createHash("sha256").update(value).digest();
};

/** Phone-specific authorization, not a second media platform. The installed
 * bridge MUST enforce a five-second lease on actual WebRTC/data/ADB peers,
 * including when this process or its connection dies. No bridge => no grants.
 */
export class PhoneAccessService {
  #repository; #directory; #bridge; #timer=null; #now; #owned=new Map(); #opening=new Set();
  constructor({repository,directory,peerBridge,now=()=>Date.now()}) {
    if (!["issue","consume","beginRevocation","confirmRevoked","active","getActive","assertLogin"].every(x=>typeof repository?.[x]==="function")
      || typeof directory?.authorization!=="function" || !["open","renew","close"].every(x=>typeof peerBridge?.[x]==="function")
      || peerBridge.maximumLeaseMilliseconds!==5000) throw new TypeError("Phone access requires an expiring, revocable peer bridge");
    this.#repository=repository;this.#directory=directory;this.#bridge=peerBridge;this.#now=now;
  }
  async #authorize(context) {
    if (!context?.identityId || !context?.sessionId) failPhone("phone_grant_invalid");
    const ownerId=identifier(context.identityId),sessionId=identifier(context.sessionId);
    const current=await this.#directory.authorization(ownerId);
    if (!current?.permissions?.includes("phone:use")) failPhone("phone_permission_required");
    await this.#repository.assertLogin({ownerId,sessionId});
    return {ownerId,sessionId};
  }
  async #close(value) {
    this.#owned.delete(value.id);
    const result=await this.#bridge.close(value);
    if (!sameBinding(result,value)||result.peerClosed!==true) failPhone("phone_runtime_unavailable");
    await this.#repository.confirmRevoked(value);
  }
  async issue({context,phoneId,input}) {
    const owner=await this.#authorize(context),{takeover,...spec}=validateConnectionRequest(input),id=identifier(phoneId);
    // Opening/reconnecting must not kick another page off the same phone.
    // Only an explicit user takeover closes the previous control peer. The
    // repository serializes claims under the phone row lock (also across APIs).
    if (spec.kind!=="control" || takeover) {
      for (const old of await this.#repository.beginRevocation({...owner,phoneId:id,sessionId:null,kind:spec.kind})) await this.#close(old);
    }
    const token=randomBytes(32).toString("base64url");
    const value=await this.#repository.issue({...owner,phoneId:id,...spec,tokenHash:tokenHash(token)});
    return {object:"virtual_phone.connection_ticket",id:value.id,phoneId:id,kind:value.kind,
      runId:value.runId,generation:value.generation,token,expiresAt:value.expiresAt,
      connectionExpiresAt:new Date(Math.min(new Date(value.expiresAt).getTime(),new Date(value.createdAt).getTime()+60_000)).toISOString()};
  }
  #lease(value) {
    // The peer still enforces a maximum of five seconds. Request four to
    // tolerate small clock differences without extending actual access.
    return Math.min(this.#now()+4000,value.kind==="adb"?new Date(value.expiresAt).getTime():Infinity);
  }
  async consume({context,phoneId,grantId,token,kind}) {
    const owner=await this.#authorize(context);
    const value=await this.#repository.consume({...owner,phoneId:identifier(phoneId),grantId:identifier(grantId),kind,tokenHash:tokenHash(token)});
    // This process owns the in-flight connection too. A reconciler tick during
    // the bounded node handshake must not mistake it for a pre-restart orphan,
    // nor send renew before the first open has reached the runtime.
    this.#owned.set(value.id,Object.freeze(structuredClone(value)));
    this.#opening.add(value.id);
    try {
      const leaseExpiresAt=this.#lease(value), opened=await this.#bridge.open({grant:value,leaseExpiresAt});
      if (!sameBinding(opened,value)||opened.peerOpen!==true||opened.leaseExpiresAt!==leaseExpiresAt) failPhone("phone_runtime_unavailable");
      // Recheck persisted/login state after external activation. A concurrent
      // stop/revoke may have happened while the bridge was being contacted.
      const current=await this.#repository.getActive(value.id);
      if (!current?.authorized || !(await this.#directory.authorization(value.ownerId))?.permissions?.includes("phone:use")) failPhone("phone_grant_invalid");
      return value; // Internal gateway binding only, not an arbitrary upstream URL.
    } catch(error) {
      // Ambiguous open still needs exact peer revocation; keep revoking on
      // failure and let the independently enforced five-second lease expire.
      for (const item of await this.#repository.beginRevocation({...owner,phoneId:value.phoneId,grantId:value.id})) {
        try {await this.#close(item);} catch {} // Reconciler retains the durable revoking record.
      }
      throw error;
    } finally {this.#opening.delete(value.id);}
  }
  // The CLI has a once-only ticket issued from the logged-in Web page, not
  // the user's password/cookie. Its owner/login are resolved from that record;
  // the normal atomic consume still verifies the token hash and current login.
  async consumeDebug({phoneId,grantId,token}) {
    identifier(phoneId);identifier(grantId);tokenHash(token);
    const value=await this.#repository.getActive(grantId);
    if(!value?.authorized || value.kind!=="adb" || value.phoneId!==phoneId || value.state!=="issued")failPhone("phone_grant_invalid");
    return this.consume({context:{identityId:value.ownerId,sessionId:value.sessionId},phoneId,grantId,token,kind:"adb"});
  }
  async revokePhoneAccess({phoneId,ownerId,runId=null,loginSessionId=null}) {
    identifier(phoneId);identifier(ownerId);if (runId) identifier(runId);
    for (const value of await this.#repository.beginRevocation({phoneId,ownerId,sessionId:loginSessionId})) await this.#close(value);
    return {phoneId,runId,accessRevoked:true};
  }
  async closeConnection({context,phoneId,grantId}) {
    const owner=await this.#authorize(context), id=identifier(phoneId), selected=identifier(grantId);
    for (const value of await this.#repository.beginRevocation({...owner,phoneId:id,grantId:selected})) await this.#close(value);
    return {phoneId:id,id:selected,closed:true};
  }
  // Internal gateway cleanup uses the binding we consumed, not a request's
  // owner fields. It must still work after the browser's login has ended.
  async disconnect(value) {
    const owned=this.#owned.get(value?.id);
    if (!owned || !sameBinding(owned,value)) return;
    this.#owned.delete(value.id);
    for (const old of await this.#repository.beginRevocation({...owned,grantId:owned.id})) await this.#close(old);
  }
  async assertConnected({context,grant}) {
    const owner=await this.#authorize(context),owned=this.#owned.get(grant?.id);
    if (!owned || !sameBinding(owned,grant) || owner.ownerId!==grant.ownerId || owner.sessionId!==grant.sessionId) failPhone("phone_grant_invalid");
    const current=await this.#repository.getActive(grant.id);
    if (!current?.authorized || current.state!=="connected" || !sameBinding(current,grant)) failPhone("phone_grant_invalid");
    return current;
  }
  async reconcile() {
    const results=await Promise.allSettled((await this.#repository.active()).map(async value=>{
      const current=await this.#directory.authorization(value.ownerId);
      if (!value.authorized || !current?.permissions?.includes("phone:use") || value.state==="connected" && !this.#owned.has(value.id)) {
        for (const old of await this.#repository.beginRevocation({...value,grantId:value.id})) await this.#close(old);
      } else if (value.state==="connected" && !this.#opening.has(value.id)) {
        const leaseExpiresAt=this.#lease(value), renewed=await this.#bridge.renew({grant:value,leaseExpiresAt});
        if (!sameBinding(renewed,value)||renewed.leaseExpiresAt!==leaseExpiresAt||renewed.peerOpen!==true) failPhone("phone_runtime_unavailable");
      }
    }));
    const failed=results.find(x=>x.status==="rejected");if (failed) throw failed.reason;
  }
  startReconciler({onError=()=>{}}={}) {
    if (this.#timer) return;let busy=false;
    this.#timer=setInterval(async()=>{if(busy)return;busy=true;try {await this.reconcile();}catch(error){onError(error);}finally{busy=false;}},2000);
    this.#timer.unref();
  }
  stopReconciler() {clearInterval(this.#timer);this.#timer=null;}
}

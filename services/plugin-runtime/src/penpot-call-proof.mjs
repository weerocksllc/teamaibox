import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PROOF = /^tabpc1_[A-Za-z0-9_-]{43}$/;
const FIELDS = ["identityId", "platformSessionId", "runtimeId", "sessionID", "connectionId", "generation", "profileId", "fileId", "pageId"];
const digest = value => createHash("sha256").update(value).digest("hex");
const denied = () => { throw Object.assign(new Error("Design connection is no longer authorized"), { code: "penpot_call_denied", status: 403 }); };

function context(value) {
  if (!value || !["server", "tool", "sessionID", "messageID", "callID"].every(key => typeof value[key] === "string" && ID.test(value[key]))) denied();
  return Object.freeze(Object.fromEntries(["server", "tool", "sessionID", "messageID", "callID"].map(key => [key, value[key]])));
}

function binding(value) {
  if (!value || !FIELDS.filter(key => key !== "generation").every(key => typeof value[key] === "string" && ID.test(value[key]))
    || !Number.isSafeInteger(value.generation) || value.generation < 1) denied();
  return Object.freeze(Object.fromEntries(FIELDS.map(key => [key, value[key]])));
}

/** Short-lived call context, not a permission/grant service or an MCP client.
 * The platform supplies its current design authorization and verified runtime
 * call. Model arguments and user-editable MCP configuration are not authorities.
 * Repositories must consume atomically and never store the raw proof.
 */
export class PenpotCallProofs {
  #repository; #authority; #clock; #confirmationKey = randomBytes(32);

  constructor({ repository, authority, clock = () => Date.now() }) {
    if (!repository?.insert || !repository?.consume || !authority?.verifyNativeCall
      || !authority?.resolveCurrentBinding || !authority?.authenticateMcp) {
      throw new TypeError("Current platform, native-call and MCP authorities are required");
    }
    this.#repository = repository;
    this.#authority = authority;
    this.#clock = clock;
  }

  #now() {
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError("Invalid proof clock");
    return now;
  }

  async #selected(runtimeAuthentication, call) {
    const native = context(call);
    // This callback MUST inspect the authenticated runtime's actual native
    // pending/running call; accepting client IDs alone does not satisfy it.
    const principal = await this.#authority.verifyNativeCall(runtimeAuthentication, native);
    if (!principal || !ID.test(principal.identityId ?? "") || !ID.test(principal.runtimeId ?? "")) denied();
    const current = binding(await this.#authority.resolveCurrentBinding(principal.identityId));
    if (current.identityId !== principal.identityId || current.runtimeId !== principal.runtimeId
      || current.sessionID !== native.sessionID || native.server !== "teamaibox-penpot") denied();
    return { native, current };
  }

  async prepare({ runtimeAuthentication, call }) {
    const {native,current}=await this.#selected(runtimeAuthentication,call);
    if(native.tool!=="execute_code")denied();
    return {target:this.#fingerprint(native,current)};
  }

  #fingerprint(native,current) {
    return createHmac("sha256",this.#confirmationKey).update(JSON.stringify([native,current])).digest("hex");
  }

  async issue({ runtimeAuthentication, call, target }) {
    const {native,current}=await this.#selected(runtimeAuthentication,call);
    if(native.tool==="execute_code") {
      const expected=this.#fingerprint(native,current);
      if(typeof target!=="string"||!/^[a-f0-9]{64}$/.test(target)
        ||!timingSafeEqual(Buffer.from(target),Buffer.from(expected)))denied();
    } else if(target!==undefined)denied();
    const proof = "tabpc1_" + randomBytes(32).toString("base64url");
    const issuedAt = this.#now(), expiresAt = issuedAt + 15_000;
    await this.#repository.insert({ proofHash: digest(proof), call: native, binding: current, issuedAt, expiresAt });
    return Object.freeze({ proof, expiresAt, ...native });
  }

  async consume({ mcpAuthentication, metadata, tool }) {
    const native = context(metadata);
    if (!PROOF.test(metadata.proof ?? "") || tool !== native.tool) denied();
    const principal = await this.#authority.authenticateMcp(mcpAuthentication);
    if (!principal || !ID.test(principal.identityId ?? "") || !ID.test(principal.runtimeId ?? "")) denied();
    // A receipt lost after this atomic operation must not replay a write.
    const now = this.#now();
    const record = await this.#repository.consume({ proofHash: digest(metadata.proof),
      identityId: principal.identityId, runtimeId: principal.runtimeId, now });
    if (!record || record.issuedAt > now || record.expiresAt <= now
      || Object.keys(native).some(key => native[key] !== record.call[key])) denied();
    const target = binding(record.binding);
    if (target.identityId !== principal.identityId || target.runtimeId !== principal.runtimeId) denied();
    await this.recheck(target);
    return Object.freeze({ ...target, ...native, expiresAt: record.expiresAt });
  }

  async recheck(target) {
    const expected = binding(target);
    const current = binding(await this.#authority.resolveCurrentBinding(expected.identityId));
    const a = Buffer.from(JSON.stringify(expected)), b = Buffer.from(JSON.stringify(current));
    if (a.length !== b.length || !timingSafeEqual(a, b)) denied();
    return current;
  }
}

import { createHash, randomBytes, randomUUID } from "node:crypto";

const digest = value => createHash("sha256").update(value).digest("hex");
const denied = () => { throw Object.assign(new Error("Design editor call refused"), { status: 403, code: "penpot_editor_call_denied" }); };
const targetFields = ["connectionId", "generation", "profileId", "fileId", "pageId"];
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validTicket=ticket=>typeof ticket==="string"&&/^tabpe1_[A-Za-z0-9_-]{43}$/.test(ticket);

function requestDigest(request) {
  if (!request || typeof request.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(request.id)
    || request.task !== "executeCode" || typeof request.params?.code !== "string"
    || Object.keys(request.params).some(key => key !== "code") || request.params.code.length > 1_000_000) denied();
  return digest(JSON.stringify([request.id, request.task, request.params.code]));
}

/** Single-use delivery binding for an existing official plugin task.
 * No tools are executed or queued here. The trusted MCP callback issues a
 * receipt; the authenticated editor redeems the exact task before native SES.
 */
export class PenpotEditorDispatches {
  #proofs; #repository; #authenticateEditor; #clock; #native;
  constructor({ proofs, repository, authenticateEditor, nativePermissions, clock = () => Date.now() }) {
    if (!proofs?.recheck || !repository?.insert || !repository?.consume || !authenticateEditor) {
      throw new TypeError("Current proof, atomic receipt and editor authorities required");
    }
    this.#proofs = proofs; this.#repository = repository;
    this.#authenticateEditor = authenticateEditor; this.#clock = clock; this.#native=nativePermissions;
  }

  /** Call only from the authenticated private MCP callback, not a browser route. */
  async issue({ binding, request }) {
    const requestHash = requestDigest(request);
    const current = await this.#proofs.recheck(binding);
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || !Number.isSafeInteger(binding.expiresAt) || binding.expiresAt <= now) denied();
    if(await this.#repository.pending?.(current.identityId,now)) {
      throw Object.assign(new Error("A previous design write must be checked"),{status:409,code:"penpot_write_review_required"});
    }
    const ticket = "tabpe1_" + randomBytes(32).toString("base64url");
    const expiresAt = Math.min(binding.expiresAt, now + 10_000);
    await this.#repository.insert({ ticketHash: digest(ticket), requestHash, binding: current, issuedAt: now, expiresAt });
    return ticket;
  }

  async consume({ editorAuthentication, request, ticket, workspace={} }) {
    if (!validTicket(ticket) || !workspace || typeof workspace!=='object'||Array.isArray(workspace)
      || Object.keys(workspace).some(key=>!['teamId','projectId'].includes(key)||!UUID.test(workspace[key]))) denied();
    const principal = await this.#authenticateEditor(editorAuthentication);
    if (!principal?.identityId || !principal?.platformSessionId || !principal?.profileId) denied();
    const now = this.#clock();
    if (!Number.isSafeInteger(now) || now < 0) denied();
    const record = await this.#repository.consume({ ticketHash: digest(ticket), reviewId:randomUUID(), workspace,
      requestHash: requestDigest(request), identityId: principal.identityId,
      platformSessionId: principal.platformSessionId, profileId: principal.profileId, now });
    if (!record || record.expiresAt <= now
      || ["identityId", "platformSessionId", "profileId"].some(key => record.binding[key] !== principal[key])) denied();
    const current = await this.#proofs.recheck(record.binding);
    return Object.freeze(Object.fromEntries(targetFields.map(key => [key, current[key]])));
  }

  async settle({ticket,uncertain}) {
    if(!validTicket(ticket)||typeof uncertain!=='boolean')denied();
    if(!await this.#repository.settle(digest(ticket),uncertain,this.#clock()))denied();
    return {received:true};
  }

  async recovery(editorAuthentication) {
    const principal=await this.#authenticateEditor(editorAuthentication);
    if(!principal?.identityId||!principal?.profileId)denied();
    const pending=await this.#repository.pending(principal.identityId,this.#clock());
    if(!pending)return null;
    const {fileId,pageId,profileId}=pending.binding;
    let target=null;
    if(profileId===principal.profileId) {
      try{
        const allowed=await this.#native.check({fileId,pageId,profileId});
        if(allowed.canRead)target={fileId,pageId,teamId:allowed.teamId,projectId:pending.workspace?.projectId??null};
      }catch{ /* do not return a revoked file's identifiers */ }
    }
    return {reviewId:pending.reviewId,state:pending.uncertain?'uncertain':'pending',target};
  }

  async reviewed({editorAuthentication,reviewId,fileId,pageId}) {
    if(!UUID.test(reviewId??''))denied();
    const principal=await this.#authenticateEditor(editorAuthentication);
    const pending=await this.recovery(editorAuthentication);
    if(!pending?.target||pending.reviewId!==reviewId||pending.state!=='uncertain'
      || fileId!==pending.target.fileId||pageId!==pending.target.pageId)denied();
    if(!await this.#repository.reviewed({...principal,reviewId,now:this.#clock()}))denied();
    return {reviewed:true};
  }
}

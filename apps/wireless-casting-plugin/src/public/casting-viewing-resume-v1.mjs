// Tab-local consent and viewing intent only. Authorization and media credentials
// are always obtained again from the server; this record grants no access.
const KEY = "teamaibox.casting-viewing-intent/v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE = new Set(["pairing", "paired", "streaming", "starting", "requested"]);
const FIELDS = ["actorIdentityId", "sessionId", "invitationId", "audienceRevision", "expiresAt", "wantsViewing"];

export function createViewingResumeStoreV1(storage, clock = () => Date.now()) {
  if (storage === undefined) {
    try { storage = globalThis.sessionStorage; } catch { /* Storage is optional. */ }
  }
  function clear() { try { storage?.removeItem(KEY); } catch { /* No persistence is required to view. */ } }
  function valid(value) {
    return value && typeof value === "object" && !Array.isArray(value)
      && Object.keys(value).length === FIELDS.length && FIELDS.every(key => Object.hasOwn(value, key))
      && UUID.test(value.actorIdentityId ?? "") && UUID.test(value.sessionId ?? "")
      && (value.invitationId === null || UUID.test(value.invitationId ?? ""))
      && Number.isSafeInteger(value.audienceRevision) && value.audienceRevision > 0
      && typeof value.expiresAt === "string" && Date.parse(value.expiresAt) > clock()
      && typeof value.wantsViewing === "boolean";
  }
  function read({ actorIdentityId, session, canView }) {
    let value;
    try { value = JSON.parse(storage?.getItem(KEY) ?? "null"); } catch { clear(); return null; }
    if (!valid(value) || !canView || !ACTIVE.has(session?.state)
      || value.actorIdentityId !== actorIdentityId || value.sessionId !== session?.id
      || value.audienceRevision !== session.audienceRevision || !session.outputSinks?.includes("browser")
      || !["initiator", "viewer"].includes(session.perspective)
      || (session.perspective === "viewer" && value.invitationId === null)
      || (session.perspective === "initiator" && value.invitationId !== null)) {
      clear(); return null;
    }
    return Object.freeze(value);
  }
  function save({ actorIdentityId, session, invitation = null, wantsViewing }) {
    // Never serialize the session, invitation or grant object wholesale.
    const expiry = Math.min(Date.parse(session?.expiresAt), invitation ? Date.parse(invitation.expiresAt) : Infinity);
    if (!Number.isFinite(expiry)) { clear(); return; }
    const value = { actorIdentityId, sessionId: session?.id,
      invitationId: invitation?.id ?? null, audienceRevision: session?.audienceRevision,
      expiresAt: new Date(expiry).toISOString(), wantsViewing };
    if (!valid(value)) { clear(); return; }
    try { storage?.setItem(KEY, JSON.stringify(value)); } catch { /* Viewing still works without storage. */ }
  }
  return Object.freeze({ read, save, clear });
}

import { createHash, randomBytes } from "node:crypto";
import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDLE = /^[A-Za-z0-9_-]{43}$/;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const deny = () => new PlatformError("cast_media_authorization_denied", "Casting media authorization was denied", { status: 403 });
const unavailable = () => new PlatformError("cast_media_connection_unavailable", "Casting media connection is unavailable", { status: 503, retryable: true });

function authenticated(context) {
  // sessionId MUST come from authenticateSession(real cookie), not a browser
  // query field or a decoded media JWT. A user identity alone is insufficient.
  if (!UUID.test(context?.identityId ?? "") || !UUID.test(context?.sessionId ?? "")
    || !context.permissions?.includes("cast:view")) throw deny();
  return { identityId: context.identityId.toLowerCase(), loginSessionId: context.sessionId.toLowerCase() };
}

/** Memory-only admission used behind Platform's same-origin authenticated WSS.
 *
 * It is deliberately not a public listener. The listener must authenticate the
 * real cookie with authenticateRequest and enforce HTTPS/origin/WS handshake.
 * It must call reauthorize for connected sockets and disconnect on every close.
 * Public direct SFU ingress must remain disabled, otherwise JWT replay could
 * bypass this boundary. No token, cookie, PIN or media is logged/persisted here.
 */
export class AuthenticatedCastingMediaAdmission {
  #service; #runtime; #authenticate; #origin; #clock; #nonce;
  #pending = new Map(); #connected = new Map(); #closed = false;

  constructor({ service, runtime, authenticateRequest, publicOrigin,
    clock = Date.now, nonce = () => randomBytes(32).toString("base64url") } = {}) {
    const parsed = new URL(publicOrigin);
    if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash
      || parsed.username || parsed.password || typeof authenticateRequest !== "function"
      || typeof clock !== "function" || typeof nonce !== "function"
      || typeof service?.createMediaConnection !== "function" || typeof service?.authorizeMediaConnection !== "function"
      || typeof service?.reauthorizeConnectedMedia !== "function"
      || typeof service?.confirmMediaConnection !== "function"
      || typeof runtime?.consumeViewerConnection !== "function" || typeof runtime?.disconnectViewer !== "function") {
      throw new TypeError("Authenticated casting media admission dependencies are invalid");
    }
    this.#service = service; this.#runtime = runtime; this.#authenticate = authenticateRequest;
    this.#origin = parsed.origin.replace(/^https:/, "wss:"); this.#clock = clock; this.#nonce = nonce;
  }

  async issue({ context, sessionId, browserInstanceId, mediaCredential }) {
    if (this.#closed) throw unavailable();
    const actor = authenticated(context);
    this.#purge();
    if (this.#pending.size + this.#connected.size >= 32) throw unavailable();
    const handle = this.#nonce();
    if (!HANDLE.test(handle) || this.#pending.has(handle) || this.#connected.has(handle)) throw unavailable();
    // Register the pending handshake before awaiting its token so parallel
    // requests cannot bypass the abuse bound. This is not a resource booking.
    const placeholder = { issuing: true, expiresAt: this.#clock() + 30_000 };
    this.#pending.set(handle, placeholder);
    try {
      const issued = await this.#service.createMediaConnection({ context, sessionId, browserInstanceId, mediaCredential });
      const expiresAt = Date.parse(issued.expiresAt);
      if (this.#closed || this.#pending.get(handle) !== placeholder || !Number.isFinite(expiresAt)
        || expiresAt <= this.#clock() || expiresAt > this.#clock() + 30_000
        || issued.sessionId !== sessionId || issued.viewerIdentityId !== actor.identityId
        || !UUID.test(issued.grantId ?? "") || typeof issued.accessToken !== "string"
        || issued.accessToken.length > 12_288) throw unavailable();
      this.#pending.set(handle, { ...actor, sessionId, browserInstanceId, mediaCredential,
        grantId: issued.grantId, tokenDigest: digest(issued.accessToken), expiresAt });
      return Object.freeze({ ...issued, url: `${this.#origin}/api/v1/casting/media/${handle}` });
    } catch {
      this.#pending.delete(handle);
      throw unavailable();
    }
  }

  async admit({ request, handle, accessToken }) {
    if (this.#closed || !HANDLE.test(handle ?? "") || typeof accessToken !== "string"
      || accessToken.length > 12_288) throw deny();
    const actor = authenticated(await this.#authenticate(request));
    this.#purge();
    const pending = this.#pending.get(handle);
    if (!pending || pending.issuing || pending.identityId !== actor.identityId
      || pending.loginSessionId !== actor.loginSessionId || pending.tokenDigest !== digest(accessToken)) throw deny();
    // A forwarded token (even to a second login of the SAME user) never consumes
    // the legitimate browser's slot. Once the right caller is matched, consume
    // before the next await so parallel Upgrade requests cannot race admission.
    this.#pending.delete(handle);
    const owned = { ...pending, ready: false, stopping: false, inFlight: true };
    this.#connected.set(handle, owned);
    try {
      await this.#authorize(pending);
      if (this.#closed || owned.stopping) throw deny();
      const consumed = await this.#runtime.consumeViewerConnection({ sessionId: pending.sessionId,
        viewerIdentityId: pending.identityId, browserInstanceId: pending.browserInstanceId, accessToken });
      if (consumed?.sessionId !== pending.sessionId || consumed?.viewerIdentityId !== pending.identityId
        || consumed?.grantId !== pending.grantId || !/^cast-[a-f0-9]{32}$/.test(consumed?.participantIdentity ?? "")) throw deny();
      if (this.#closed || this.#connected.get(handle) !== owned || owned.stopping) throw deny();
      // Recheck after consuming: a membership/permission change during the
      // private request must not obtain a new SFU connection.
      await this.#authorize(pending);
      if (this.#closed || owned.stopping) throw deny();
      const confirmed = await this.#service.confirmMediaConnection({ sessionId: pending.sessionId,
        viewerIdentityId: pending.identityId, browserInstanceId: pending.browserInstanceId,
        mediaCredential: pending.mediaCredential });
      if (confirmed?.admitted !== true || this.#closed || this.#connected.get(handle) !== owned || owned.stopping) throw deny();
      owned.inFlight = false;
      owned.ready = true;
      delete owned.mediaCredential;
      return Object.freeze({ connectionId: handle, sessionId: pending.sessionId,
        participantIdentity: consumed.participantIdentity });
    } catch {
      owned.inFlight = false;
      await this.disconnect(handle).catch(() => {});
      throw deny();
    }
  }

  async reauthorize({ request, connectionId }) {
    const owned = this.#connected.get(connectionId);
    if (!owned || !owned.ready || owned.stopping || this.#closed) throw deny();
    try {
      const context = await this.#authenticate(request);
      // Reconcile the stored grant before the request-level permission check.
      // Otherwise losing cast:view closes WSS but leaves a joined viewer behind.
      await this.#authorize(owned, true);
      const actor = authenticated(context);
      if (actor.identityId !== owned.identityId || actor.loginSessionId !== owned.loginSessionId) throw deny();
      // Login, grant and audience are rechecked, NOT the 30-second join expiry.
      // The join token expiring must not interrupt an authorized active viewer.
      return Object.freeze({ authorized: true });
    } catch {
      await this.disconnect(connectionId).catch(() => {});
      throw deny();
    }
  }

  async disconnect(connectionId) {
    const owned = this.#connected.get(connectionId);
    if (!owned) return;
    owned.stopping = true;
    // Closing WSS alone does NOT prove RTP has stopped. The runtime must remove
    // the actual SFU participant and confirm removal before ownership is freed.
    try {
      await this.#runtime.disconnectViewer({ sessionId: owned.sessionId, viewerIdentityId: owned.identityId,
        browserInstanceId: owned.browserInstanceId,
        reasonCode: "cast_authenticated_ingress_closed" });
    } catch { throw unavailable(); }
    // A concurrent admission may still be completing its private consume. Keep
    // the exact cleanup target until that operation settles, then remove again.
    if (!owned.inFlight) this.#connected.delete(connectionId);
  }

  async close() {
    this.#closed = true; this.#pending.clear();
    const results = await Promise.allSettled([...this.#connected.keys()].map((id) => this.disconnect(id)));
    if (results.some((result) => result.status === "rejected") || this.#connected.size) throw unavailable();
  }

  async retryCleanup() {
    // A private consume may fail before admit() returns a connection handle
    // to the gateway. Those uncertain resources still need the same sweep.
    await Promise.allSettled([...this.#connected.entries()]
      .filter(([, owned]) => owned.stopping)
      .map(([id]) => this.disconnect(id)));
  }

  status() {
    this.#purge();
    return Object.freeze({ pendingCount: this.#pending.size, connectionCount: this.#connected.size,
      cleanupPendingCount: [...this.#connected.values()].filter((v) => v.stopping).length, closed: this.#closed });
  }

  async #authorize(owned, established = false) {
    const current = established
      ? await this.#service.reauthorizeConnectedMedia({ sessionId: owned.sessionId,
        viewerIdentityId: owned.identityId, grantId: owned.grantId })
      : await this.#service.authorizeMediaConnection({ sessionId: owned.sessionId,
      viewerIdentityId: owned.identityId, browserInstanceId: owned.browserInstanceId,
      mediaCredential: owned.mediaCredential });
    if (current?.authorized !== true || current.sessionId !== owned.sessionId
      || current.viewerIdentityId !== owned.identityId || current.grantId !== owned.grantId
      || !Number.isFinite(Date.parse(current.expiresAt)) || Date.parse(current.expiresAt) <= this.#clock()) throw deny();
  }

  #purge() {
    for (const [id, owned] of this.#pending) if (owned.expiresAt <= this.#clock()) this.#pending.delete(id);
  }
}

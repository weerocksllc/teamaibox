import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const CODE = /^tabpd1_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const APP = "official.penpot";

export class PenpotHandoffError extends Error {
  constructor() {
    super("Design sign-in is unavailable or has expired");
    this.name = "PenpotHandoffError";
    this.code = "penpot_handoff_denied";
    this.status = 403;
  }
}

function deny() { throw new PenpotHandoffError(); }
function identity(context) { return context?.identityId ?? context?.identity?.id; }
function validAccess(access) {
  return access?.pluginId === APP && access.allowed === true
    && typeof access.version === "string" && access.version.length > 0
    && access.version.length <= 128 && Number.isSafeInteger(access.generation) && access.generation > 0;
}

/** Narrow one-use sign-in bridge, not a replacement identity provider.
 * Both callbacks must consult the existing platform authorities. The caller of
 * redeem is the private Penpot backend, never the browser or an agent tool.
 */
export class PenpotLoginHandoff {
  #repository; #authentication; #authorizeDesign; #loadSession;
  #installationId; #pepper; #backendKey; #clock;

  constructor({ repository, authentication, authorizeDesign, loadSession,
    installationId, tokenPepper, backendKey, clock = () => new Date() }) {
    if (!repository?.insert || !repository?.consume || !repository?.getOrCreateProfile
      || !authentication?.authenticateSession || typeof authorizeDesign !== "function"
      || typeof loadSession !== "function" || !UUID.test(installationId ?? "")
      || !(tokenPepper instanceof Uint8Array) || tokenPepper.byteLength < 32
      || typeof backendKey !== "string" || !/^[A-Za-z0-9_-]{43,128}$/.test(backendKey)) {
      throw new TypeError("Penpot handoff requires platform authentication and private service credentials");
    }
    this.#repository = repository;
    this.#authentication = authentication;
    this.#authorizeDesign = authorizeDesign;
    this.#loadSession = loadSession;
    this.#installationId = installationId;
    this.#pepper = Buffer.from(tokenPepper);
    this.#backendKey = this.#hash(backendKey);
    this.#clock = clock;
  }

  #hash(value) { return createHmac("sha256", this.#pepper).update(value).digest(); }
  #now() {
    const value = new Date(this.#clock());
    if (!Number.isFinite(value.getTime())) throw new TypeError("Invalid handoff clock");
    return value;
  }

  async issue({ sessionToken, csrfToken }) {
    const context = await this.#authentication.authenticateSession({ sessionToken, csrfToken, requireCsrf: true });
    const identityId = identity(context);
    if (!UUID.test(identityId ?? "") || !UUID.test(context?.sessionId ?? "")) deny();
    const now = this.#now();
    const access = await this.#authorizeDesign(context, now);
    if (!validAccess(access)) deny();
    const code = `tabpd1_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(now.getTime() + 60_000);
    await this.#repository.insert({ codeHash: this.#hash(code), installationId: this.#installationId,
      identityId, sessionId: context.sessionId, version: access.version, generation: access.generation,
      issuedAt: now, expiresAt });
    // No owner/file/path is accepted from the client. Native ACLs choose the
    // destination after login; later explicit file opens must re-authorize it.
    return Object.freeze({ code, expiresAt: expiresAt.toISOString() });
  }

  async redeem({ code, backendKey, identityId, sessionId }) {
    if (typeof backendKey !== "string" || backendKey.length > 128
      || !timingSafeEqual(this.#hash(backendKey), this.#backendKey)
      || !CODE.test(code ?? "") || !UUID.test(identityId ?? "") || !UUID.test(sessionId ?? "")) deny();
    const now = this.#now();
    // The SQL DELETE is the only consumption point. Concurrent requests and
    // lost receipts never replay login. A failed exchange needs a fresh code.
    const record = await this.#repository.consume({ codeHash: this.#hash(code),
      installationId: this.#installationId, identityId, sessionId, now });
    if (!record) deny();
    const context = await this.#loadSession(identityId, sessionId, now);
    if (identity(context) !== identityId || context?.sessionId !== sessionId) deny();
    const access = await this.#authorizeDesign(context, now);
    if (!validAccess(access) || access.version !== record.version || access.generation !== record.generation) deny();
    const profileId = await this.#repository.getOrCreateProfile(this.#installationId, identityId);
    if (!UUID.test(profileId ?? "")) throw new TypeError("Invalid native design identity mapping");
    // This is intentionally not the user's email. It is never mailed and is
    // not used to find or adopt an existing native account.
    return Object.freeze({ profileId, contact: `${profileId}@design.invalid`,
      fullname: String(context.identity?.displayName ?? context.displayName ?? "Team member").slice(0, 200),
      installationId: this.#installationId, identityId, sessionId });
  }
}

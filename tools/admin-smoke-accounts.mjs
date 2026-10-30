import { randomBytes } from "node:crypto";

const LOGIN = /^[a-z][a-z0-9._-]{2,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Credentials are accepted only over the caller's protected stdin, never flags.
export async function readSmokeAccounts(input = process.stdin, { targetRequired = false } = {}) {
  const chunks = [];
  let raw;
  try {
    let size = 0;
    for await (const chunk of input) {
      const bytes = Buffer.from(chunk);
      chunks.push(bytes);
      size += bytes.length;
      if (size > 65_536) throw new Error();
    }
    raw = Buffer.concat(chunks);
    const value = JSON.parse(raw.toString("utf8"));
    const accounts = {};
    for (const key of targetRequired ? ["owner", "member", "target"] : ["owner", "member"]) {
      const loginName = value?.[key]?.loginName;
      const password = value?.[key]?.password;
      if (typeof loginName !== "string" || !LOGIN.test(loginName)
        || typeof password !== "string" || password.length < 8 || password.length > 256
        || /\p{Cc}/u.test(password)) throw new Error();
      accounts[key] = { loginName, password };
    }
    if (new Set(Object.values(accounts).map(account => account.loginName)).size !== Object.keys(accounts).length) throw new Error();
    return accounts;
  } catch {
    throw new Error(targetRequired
      ? "Protected stdin must contain distinct owner, member and target credentials"
      : "Protected stdin must contain distinct owner and member credentials");
  } finally {
    raw?.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

export function clearSmokeAccounts(accounts) {
  for (const account of Object.values(accounts)) if (account) account.password = "";
}

export function temporarySmokeAccount() {
  return {
    loginName: `smoke-${randomBytes(24).toString("hex")}`,
    displayName: "Temporary browser verification member",
    initialPassword: randomBytes(48).toString("base64url"),
    replacementPassword: randomBytes(48).toString("base64url"),
  };
}

function checkedJson(response) {
  if (response?.status !== 200) throw new Error("Temporary account administration request failed");
  try { return JSON.parse(response.bytes.toString("utf8")); }
  catch { throw new Error("Temporary account administration response is invalid"); }
}

export function temporaryAccountLifecycle({ origin, account, owner, signIn, request }) {
  let prepared = false;
  let creationAttempted = false;
  let ownerSession;
  async function authenticate() {
    const result = await signIn(origin, owner.loginName, owner.password);
    if (result?.status !== 200 || !result.session) throw new Error("Temporary account cleanup owner authentication failed");
    ownerSession = result.session;
  }
  async function lookup() {
    const page = checkedJson(await request(origin, `/api/v1/admin/users?limit=200&q=${encodeURIComponent(account.loginName)}`, { session: ownerSession }));
    if (!Array.isArray(page.data) || page.hasMore !== false) throw new Error("Temporary account lookup is incomplete");
    const found = page.data.filter(value => value.loginName === account.loginName);
    if (found.length > 1) throw new Error("Temporary account lookup is ambiguous");
    if (found[0] && (!UUID.test(found[0].id ?? "") || found[0].identityKind !== "local_user")) throw new Error("Temporary account identity is invalid");
    return found[0];
  }
  return {
    async prepare() {
      if (!LOGIN.test(account.loginName) || account.loginName === owner.loginName) throw new Error("Temporary account identity is unsafe");
      await authenticate();
      if (await lookup()) throw new Error("Temporary account already exists; refusing to reuse it");
      prepared = true;
    },
    markCreationAttempted() {
      if (!prepared) throw new Error("Temporary account preflight is required");
      creationAttempted = true;
    },
    async cleanup() {
      if (!creationAttempted) return { status: "passed", temporaryAccount: "not-created" };
      try {
        // Use a fresh owner session even when browser navigation or sign-in failed.
        await authenticate();
        const identity = await lookup();
        // An interrupted create request has an unknown outcome, not proven cleanup.
        if (!identity) throw new Error();
        const disabled = checkedJson(await request(origin, `/api/v1/admin/users/${identity.id}/disable`, {
          method: "POST", body: {}, session: ownerSession,
        }));
        if (disabled.id !== identity.id || disabled.status !== "disabled") throw new Error();
        const confirmed = await lookup();
        if (confirmed?.id !== identity.id || confirmed.status !== "disabled") throw new Error();
        return { status: "passed", temporaryAccount: "disabled" };
      } catch {
        throw new Error("Temporary account cleanup failed; account disablement is not confirmed");
      } finally {
        ownerSession = null;
      }
    },
  };
}

export function cleanupFailure(previous) {
  return {
    type: "TemporaryAccountCleanupError",
    message: "Temporary account cleanup failed; account disablement is not confirmed",
    ...(previous ? { precedingFailure: previous } : {}),
  };
}

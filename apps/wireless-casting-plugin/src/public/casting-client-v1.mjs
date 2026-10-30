const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OUTPUTS = new Set(["browser"]);
const AUDIENCES = new Set(["owner_only", "selected_users", "selected_team"]);
const SESSION_STATES = new Set(["requested", "starting", "pairing", "paired", "streaming", "stopping", "stopped", "expired", "failed"]);
const AVAILABILITY_STATES = new Set(["ready", "unsupported", "unknown"]);
const AVAILABILITY_MODES = new Set(["disabled", "runtime"]);
const AVAILABILITY_CATEGORIES = new Set(["legal", "supply_chain", "hardware", "runtime", "security"]);
const REASON_CODE = /^[a-z][a-z0-9_]{2,127}$/;
const RECEIVER_NAME = /^Team-AI-[0-9A-F]{10}$/;
const PAIRING_PIN = /^[1-9][0-9]{3}$/;
const MEDIA_CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const MEDIA_ACCESS_TOKEN = /^[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,8192}\.[A-Za-z0-9_-]{8,2048}$/;
const COMMON_SESSION_KEYS = Object.freeze(["id", "object", "state", "stateRevision", "audienceRevision",
  "outputSinks", "browserAudience", "expiresAt", "createdAt", "updatedAt", "terminalAt", "terminalReasonCode"]);

export class CastingApiError extends Error {
  constructor(code, message, status = 500, retryable = false, details = null) {
    super(message);
    this.name = "CastingApiError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

function invalid(message) {
  throw new CastingApiError("cast_response_invalid", message, 502, false);
}

function exactObjectKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
}

function uniqueUuidList(value, maximum = 50) {
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => !UUID.test(item ?? ""))) return null;
  const normalized = value.map((item) => item.toLowerCase());
  return new Set(normalized).size === normalized.length ? normalized : null;
}

function outputSinks(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2
    || value.some((item) => !OUTPUTS.has(item)) || new Set(value).size !== value.length) return null;
  return ["browser"].filter((item) => value.includes(item));
}

function validTimestamp(value, nullable = false) {
  if (nullable && value === null) return true;
  return typeof value === "string" && Number.isFinite(new Date(value).getTime());
}

function normalizeOutputHealth(value, sinks) {
  if (value === null) return null;
  if (!exactObjectKeys(value, ["receiverHealthy", "outputs"])
      || typeof value.receiverHealthy !== "boolean" || !value.outputs || typeof value.outputs !== "object"
      || Array.isArray(value.outputs) || !exactObjectKeys(value.outputs, sinks)
      || sinks.some((sink) => !new Set(["available", "unavailable", "unknown"]).has(value.outputs[sink]))) {
    invalid("Casting output health is invalid");
  }
  return Object.freeze({ receiverHealthy: value.receiverHealthy,
    outputs: Object.freeze(Object.fromEntries(sinks.map((sink) => [sink, value.outputs[sink]]))) });
}

function normalizeReceiver(value) {
  if (!exactObjectKeys(value, ["name", "pin", "sourcePaired", "sourceDeviceLabel"])
      || !RECEIVER_NAME.test(value.name ?? "") || typeof value.pin !== "string"
      || value.pin.length !== 4 || !PAIRING_PIN.test(value.pin)
      || typeof value.sourcePaired !== "boolean"
      || !(value.sourceDeviceLabel === null || (typeof value.sourceDeviceLabel === "string"
        && [...value.sourceDeviceLabel].length >= 1 && [...value.sourceDeviceLabel].length <= 128
        && !/[\u0000-\u001f\u007f]/u.test(value.sourceDeviceLabel)))) {
    invalid("Casting receiver response is invalid");
  }
  return Object.freeze({ name: value.name, pin: value.pin, sourcePaired: value.sourcePaired,
    sourceDeviceLabel: value.sourceDeviceLabel });
}

export function castingSessionPerspectiveV1(value) {
  if (value?.object === "cast.session.health") return "manager";
  if (value?.object !== "cast.session") return null;
  return Object.hasOwn(value, "viewerUserIds") || Object.hasOwn(value, "viewerTeamId") ? "initiator" : "viewer";
}

export function normalizeCastingSessionV1(value) {
  if (value === null) return null;
  const perspective = castingSessionPerspectiveV1(value);
  const hasSourceState = Object.hasOwn(value, "sourceState");
  const sessionKeys = [...COMMON_SESSION_KEYS, ...(hasSourceState ? ["sourceState", "sourceStateRevision"] : [])];
  if (hasSourceState !== Object.hasOwn(value, "sourceStateRevision")
      || (hasSourceState && (!["waiting", "connected", "disconnected", "unknown"].includes(value.sourceState)
        || !Number.isSafeInteger(value.sourceStateRevision) || value.sourceStateRevision < 1))) {
    invalid("Casting source state is invalid");
  }
  const sinks = outputSinks(value?.outputSinks);
  if (!perspective || !UUID.test(value?.id ?? "") || !SESSION_STATES.has(value?.state)
    || !Number.isSafeInteger(value?.stateRevision) || value.stateRevision < 1
    || !Number.isSafeInteger(value?.audienceRevision) || value.audienceRevision < 1
    || !sinks || !validTimestamp(value?.expiresAt) || !validTimestamp(value?.createdAt)
    || !validTimestamp(value?.updatedAt) || !validTimestamp(value?.terminalAt, true)
    || !(value?.terminalReasonCode === null || REASON_CODE.test(value?.terminalReasonCode ?? ""))) {
    invalid("Casting session response is invalid");
  }
  const terminal = new Set(["stopped", "expired", "failed"]).has(value.state);
  if (terminal !== (value.terminalAt !== null && value.terminalReasonCode !== null)) {
    invalid("Casting terminal state is invalid");
  }
  const browserAudience = value.browserAudience;
  if (sinks.includes("browser") !== AUDIENCES.has(browserAudience)) invalid("Casting session audience is invalid");
  let allowedKeys = sessionKeys;
  let viewerUserIds;
  let viewerTeamId;
  let receiver;
  let outputHealth;
  let viewerCount;
  let receiverHealthy;
  if (perspective === "viewer") {
    if (!exactObjectKeys(value, sessionKeys)) invalid("Viewer casting response exposed unrecognized data");
  }
  if (perspective === "initiator") {
    const users = uniqueUuidList(value.viewerUserIds);
    if (!users || (value.viewerTeamId !== null && !UUID.test(value.viewerTeamId ?? ""))) invalid("Casting audience targets are invalid");
    if ((browserAudience === "owner_only" && (users.length !== 0 || value.viewerTeamId !== null))
        // Stop responses omit former audience targets after grants are closed.
        // Only a proven terminal state may omit them; active views remain strict.
        || (browserAudience === "selected_users" && ((!terminal && users.length < 1) || value.viewerTeamId !== null))
        || (browserAudience === "selected_team" && (users.length !== 0 || (!terminal && value.viewerTeamId === null)))
        || (browserAudience === null && (users.length !== 0 || value.viewerTeamId !== null))) {
      invalid("Casting audience targets conflict with the session audience");
    }
    allowedKeys = [...sessionKeys, "viewerUserIds", "viewerTeamId", "outputHealth",
      ...(Object.hasOwn(value, "receiver") ? ["receiver"] : [])];
    if (!exactObjectKeys(value, allowedKeys)) invalid("Initiator casting response exposed unrecognized data");
    viewerUserIds = Object.freeze(users);
    viewerTeamId = value.viewerTeamId?.toLowerCase?.() ?? null;
    outputHealth = normalizeOutputHealth(value.outputHealth, sinks);
    receiver = Object.hasOwn(value, "receiver") ? normalizeReceiver(value.receiver) : undefined;
  }
  if (perspective === "manager") {
    allowedKeys = [...sessionKeys, "viewerCount", "outputHealth",
      ...(Object.hasOwn(value, "receiverHealthy") ? ["receiverHealthy"] : [])];
    if (!exactObjectKeys(value, allowedKeys)) invalid("Manager casting response exposed unrecognized data");
    if (!(value.viewerCount === null || (Number.isSafeInteger(value.viewerCount)
      && value.viewerCount >= 0))) invalid("Casting viewer count is invalid");
    viewerCount = value.viewerCount;
    outputHealth = normalizeOutputHealth(value.outputHealth, sinks);
    if (Object.hasOwn(value, "receiverHealthy")) {
      if (typeof value.receiverHealthy !== "boolean" || outputHealth === null
          || value.receiverHealthy !== outputHealth.receiverHealthy) invalid("Casting receiver health is invalid");
      receiverHealthy = value.receiverHealthy;
    }
  }
  return Object.freeze({
    id: value.id.toLowerCase(), object: value.object, state: value.state, stateRevision: value.stateRevision,
    audienceRevision: value.audienceRevision, outputSinks: Object.freeze(sinks), browserAudience,
    expiresAt: value.expiresAt, createdAt: value.createdAt, updatedAt: value.updatedAt,
    terminalAt: value.terminalAt, terminalReasonCode: value.terminalReasonCode,
    ...(hasSourceState ? { sourceState: value.sourceState, sourceStateRevision: value.sourceStateRevision } : {}),
    ...(perspective === "initiator" ? { viewerUserIds, viewerTeamId, outputHealth,
      ...(receiver === undefined ? {} : { receiver }) } : {}),
    ...(perspective === "manager" ? { viewerCount, outputHealth,
      ...(receiverHealthy === undefined ? {} : { receiverHealthy }) } : {}),
    perspective,
  });
}

export function normalizeCastingInvitationV1(item) {
  if (!exactObjectKeys(item, ["id", "object", "sessionId", "state", "audienceRevision", "issuedAt", "expiresAt", "resolvedAt"])
      || item.object !== "cast.viewer_invitation" || !UUID.test(item.id ?? "") || !UUID.test(item.sessionId ?? "")
      || !new Set(["pending", "accepted", "declined", "revoked", "expired"]).has(item.state)
      || !Number.isSafeInteger(item.audienceRevision) || item.audienceRevision < 1
      || !validTimestamp(item.issuedAt) || !validTimestamp(item.expiresAt) || !validTimestamp(item.resolvedAt, true)) {
    invalid("Casting invitation item is invalid");
  }
  return Object.freeze({ id: item.id.toLowerCase(), object: item.object, sessionId: item.sessionId.toLowerCase(),
    state: item.state, audienceRevision: item.audienceRevision, issuedAt: item.issuedAt,
    expiresAt: item.expiresAt, resolvedAt: item.resolvedAt });
}

export function normalizeCastingInvitationsV1(value) {
  if (!exactObjectKeys(value, ["object", "data"]) || value.object !== "list" || !Array.isArray(value.data)) {
    invalid("Casting invitation response is invalid");
  }
  const seen = new Set();
  return Object.freeze(value.data.map((item) => {
    const normalized = normalizeCastingInvitationV1(item);
    if (seen.has(normalized.id)) invalid("Casting invitation item is duplicated");
    seen.add(normalized.id);
    return normalized;
  }));
}

export function normalizeCastingViewersV1(value) {
  if (!exactObjectKeys(value, ["object", "data"]) || value.object !== "list"
      || !Array.isArray(value.data)) invalid("Casting viewer response is invalid");
  const seen = new Set();
  return Object.freeze(value.data.map((item) => {
    const id = item?.viewerIdentityId?.toLowerCase?.();
    if (!exactObjectKeys(item, ["viewerIdentityId", "displayName", "joinedAt", "expiresAt"])
      || !UUID.test(id ?? "") || seen.has(id) || (item.displayName !== null && (typeof item.displayName !== "string"
        || [...item.displayName].length < 1 || [...item.displayName].length > 128 || /[\u0000-\u001f\u007f]/u.test(item.displayName)))
      || !validTimestamp(item.joinedAt) || !validTimestamp(item.expiresAt)) invalid("Casting viewer item is invalid");
    seen.add(id);
    return Object.freeze({ viewerIdentityId: id, displayName: item.displayName,
      joinedAt: item.joinedAt, expiresAt: item.expiresAt });
  }));
}

export function normalizeCastingJoinV1(value) {
  if (!exactObjectKeys(value, ["sessionId", "viewerIdentityId", "grantId", "mediaCredential", "expiresAt", "muted"])
      || !UUID.test(value.sessionId ?? "") || !UUID.test(value.viewerIdentityId ?? "")
      || !UUID.test(value.grantId ?? "") || !MEDIA_CREDENTIAL.test(value.mediaCredential ?? "")
      || !validTimestamp(value.expiresAt) || typeof value.muted !== "boolean") invalid("Casting viewer grant is invalid");
  return Object.freeze({ sessionId: value.sessionId.toLowerCase(), viewerIdentityId: value.viewerIdentityId.toLowerCase(),
    grantId: value.grantId.toLowerCase(), mediaCredential: value.mediaCredential,
    expiresAt: value.expiresAt, muted: value.muted });
}

export function normalizeCastingMediaConnectionV1(value, browserOrigin = globalThis.location?.origin) {
  if (!exactObjectKeys(value, ["sessionId", "viewerIdentityId", "grantId", "url", "accessToken", "expiresAt", "muted"])
      || !UUID.test(value.sessionId ?? "") || !UUID.test(value.viewerIdentityId ?? "")
      || !UUID.test(value.grantId ?? "") || !MEDIA_ACCESS_TOKEN.test(value.accessToken ?? "")
      || !validTimestamp(value.expiresAt) || typeof value.muted !== "boolean"
      || typeof value.url !== "string" || value.url.length > 512) {
    invalid("Casting media connection is invalid");
  }
  let endpoint;
  try { endpoint = new URL(value.url); } catch { invalid("Casting media connection URL is invalid"); }
  if (endpoint.protocol !== "wss:" || endpoint.username || endpoint.password || endpoint.hash
      || endpoint.search || !endpoint.hostname) invalid("Casting media connection URL is invalid");
  // The authenticated relay lives on this appliance's current browser origin.
  // An old internal canonical origin must not send clients to a former DHCP IP.
  if (/^\/api\/v1\/casting\/media\/[A-Za-z0-9_-]{43}$/.test(endpoint.pathname) && browserOrigin) {
    const current = new URL(browserOrigin);
    if (current.protocol !== 'https:' || current.username || current.password) invalid('Casting requires HTTPS');
    endpoint.host = current.host;
  }
  return Object.freeze({ sessionId: value.sessionId.toLowerCase(),
    viewerIdentityId: value.viewerIdentityId.toLowerCase(), grantId: value.grantId.toLowerCase(),
    url: endpoint.toString(), accessToken: value.accessToken, expiresAt: value.expiresAt, muted: value.muted });
}

function normalizeCastingLeaveV1(value) {
  if (!exactObjectKeys(value, ["sessionId", "left"]) || !UUID.test(value.sessionId ?? "")
      || typeof value.left !== "boolean") invalid("Casting leave response is invalid");
  return Object.freeze({ sessionId: value.sessionId.toLowerCase(), left: value.left });
}

function normalizeCastingRemoveViewerV1(value) {
  if (!exactObjectKeys(value, ["sessionId", "viewerIdentityId", "removed"])
      || !UUID.test(value.sessionId ?? "") || !UUID.test(value.viewerIdentityId ?? "")
      || typeof value.removed !== "boolean") invalid("Casting viewer removal response is invalid");
  return Object.freeze({ sessionId: value.sessionId.toLowerCase(),
    viewerIdentityId: value.viewerIdentityId.toLowerCase(), removed: value.removed });
}

export function normalizeCastingAvailabilityV1(value) {
  if (!exactObjectKeys(value, ["schemaVersion", "object", "mode", "state", "receiverReady", "sessionStartAllowed",
    "receiverAdvertisementAllowed", "outputs", "gates", "limitations", "successor"])
      || value.schemaVersion !== 1 || value.object !== "cast.availability"
      || !AVAILABILITY_MODES.has(value.mode) || !AVAILABILITY_STATES.has(value.state)
      || typeof value.receiverReady !== "boolean" || typeof value.sessionStartAllowed !== "boolean"
      || typeof value.receiverAdvertisementAllowed !== "boolean"
      || !value.outputs || typeof value.outputs !== "object" || Array.isArray(value.outputs)
      || new Set(Object.keys(value.outputs)).size !== 1
      || !Object.hasOwn(value.outputs, "browser") || !Array.isArray(value.gates) || value.gates.length > 32
      || !exactObjectKeys(value.limitations, ["appleCertified", "fairPlayDrmSupported", "syntheticAcceptanceAllowed"])
      || value.limitations.appleCertified !== false || value.limitations.fairPlayDrmSupported !== false
      || value.limitations?.syntheticAcceptanceAllowed !== false
      || !exactObjectKeys(value.successor, ["atomicCutoverRequired"])
      || value.successor.atomicCutoverRequired !== true) {
    invalid("Casting availability response is invalid");
  }
  const outputs = {};
  for (const output of ["browser"]) {
    const item = value.outputs[output];
    if (!exactObjectKeys(item, ["state", "reasonCode"])
        || !new Set(["available", "unavailable", "unknown"]).has(item.state)
        || !(item.reasonCode === null || REASON_CODE.test(item.reasonCode ?? ""))) {
      invalid("Casting output availability is invalid");
    }
    outputs[output] = Object.freeze({ state: item.state, reasonCode: item.reasonCode });
  }
  const seen = new Set();
  const gates = value.gates.map((gate) => {
    if (!exactObjectKeys(gate, ["code", "category", "state"]) || !REASON_CODE.test(gate.code ?? "")
        || !AVAILABILITY_CATEGORIES.has(gate.category) || !new Set(["blocked", "passed"]).has(gate.state)
        || seen.has(gate.code)) invalid("Casting availability gate is invalid");
    seen.add(gate.code);
    return Object.freeze({ code: gate.code, category: gate.category, state: gate.state });
  });
  if (value.mode === "disabled" && (value.state !== "unsupported" || value.receiverReady
      || value.sessionStartAllowed || value.receiverAdvertisementAllowed || gates.length < 1
      || gates.some((gate) => gate.state !== "blocked")
      || Object.values(outputs).some((output) => output.state !== "unavailable"))) {
    invalid("Disabled casting availability contains a positive claim");
  }
  if ((value.receiverReady || value.sessionStartAllowed) && value.state !== "ready") {
    invalid("Casting readiness claims conflict with availability state");
  }
  if (value.state === "ready" && (!value.receiverReady || !value.sessionStartAllowed
      || gates.some((gate) => gate.state === "blocked"))) {
    invalid("Casting ready state is incomplete or still blocked");
  }
  return Object.freeze({ ...value, outputs: Object.freeze(outputs), gates: Object.freeze(gates),
    limitations: Object.freeze({ ...value.limitations }), successor: Object.freeze({ ...value.successor }) });
}

export function browserPlaybackPolicyV1(outputSinksValue) {
  const sinks = outputSinks(outputSinksValue);
  if (!sinks || !sinks.includes("browser")) return Object.freeze({ available: false, explicitJoinRequired: true, initiallyMuted: false });
  return Object.freeze({ available: true, explicitJoinRequired: true, initiallyMuted: false });
}

export function validateCastingDraftV1(draft, actorIdentityId = null) {
  const sinks = ["browser"];
  const errors = [];
  if ((draft?.hdmi !== undefined && draft.hdmi !== false) || (draft?.browser !== undefined && draft.browser !== true)) errors.push("cast_output_invalid");
  const ttl = Number(draft?.ttlSeconds);
  if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 14_400) errors.push("cast_ttl_invalid");
  const audience = draft?.browserAudience;
  const users = uniqueUuidList(draft?.viewerUserIds ?? []);
  const teamId = typeof draft?.viewerTeamId === "string" ? draft.viewerTeamId.trim().toLowerCase() : null;
  if (!AUDIENCES.has(audience)) errors.push("cast_audience_invalid");
  if (!users) errors.push("cast_audience_invalid");
  if (actorIdentityId && users?.includes(actorIdentityId.toLowerCase())) errors.push("cast_audience_includes_initiator");
  if (audience === "owner_only" && ((users?.length ?? 0) > 0 || teamId)) errors.push("cast_audience_invalid");
  if (audience === "selected_users" && ((users?.length ?? 0) < 1 || teamId)) errors.push("cast_selected_users_required");
  if (audience === "selected_team" && ((users?.length ?? 0) > 0 || !UUID.test(teamId ?? ""))) errors.push("cast_selected_team_required");
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze([...new Set(errors)]), body: Object.freeze({
    output_sinks: Object.freeze(sinks), browser_audience: audience,
    viewer_user_ids: Object.freeze(audience === "selected_users" && users ? users : []),
    viewer_team_id: audience === "selected_team" && UUID.test(teamId ?? "") ? teamId : null,
    ttl_seconds: ttl,
  }) });
}

function csrfFromCookie(cookie) {
  const values = String(cookie ?? "").split(";").map((part) => part.trim())
    .filter((part) => part.startsWith("__Host-teamaibox-csrf="));
  if (values.length !== 1) throw new CastingApiError("csrf_unavailable", "Secure session verification is unavailable", 401, false);
  return values[0].slice(values[0].indexOf("=") + 1);
}

export async function fetchCastingJsonV1(path, options = {}, { fetchImpl = globalThis.fetch,
  timeoutMs = options.method && options.method !== "GET" ? 30_000 : 12_000 } = {}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new CastingApiError("cast_request_timeout", "Request timed out; reconcile state before retrying", 504, true));
      controller.abort();
    }, timeoutMs);
  });
  const read = async () => {
    let response;
    try { response = await fetchImpl(path, { credentials: "same-origin", ...options, signal: controller.signal }); }
    catch { throw new CastingApiError("cast_network_unavailable", "Casting service could not be reached", 503, true); }
    let value;
    try { value = await response.json(); }
    catch { throw new CastingApiError("cast_response_invalid", "Casting service returned an invalid response", 502, true); }
    if (!response.ok) throw new CastingApiError(value?.error?.code ?? "cast_request_failed",
      value?.error?.message ?? "Casting request failed", response.status,
      value?.error?.retryable === true || response.status >= 500 || response.status === 429,
      value?.error?.details ?? null);
    return value;
  };
  try { return await Promise.race([read(), deadline]); }
  finally { clearTimeout(timer); }
}

export async function readCastingSessionV1(api) {
  // A session can end between current() and viewers(). Reconcile once, never
  // retain the previous session/viewer list or retry a mutating operation.
  for (let attempt = 0; attempt < 2; attempt++) {
    let session;
    try { session = await api.current(); }
    catch (error) { if (error.code !== "cast_session_not_found") throw error; }
    if (!session || ["stopped", "expired", "failed"].includes(session.state)) return { session: null, viewers: [] };
    try {
      return { session, viewers: session.perspective === "initiator" ? await api.viewers(session.id) : [] };
    } catch (error) {
      if (!["cast_session_terminal", "cast_session_not_found"].includes(error.code) || attempt === 1) throw error;
    }
  }
}

export function createCastingApiV1({ fetchImpl = globalThis.fetch, cookie = () => globalThis.document?.cookie ?? "",
  randomUUID = () => globalThis.crypto.randomUUID() } = {}) {
  if (typeof fetchImpl !== "function" || typeof cookie !== "function" || typeof randomUUID !== "function") {
    throw new TypeError("Casting API dependencies are invalid");
  }
  async function request(path, { method = "GET", body, idempotencyKey = null } = {}) {
    const mutating = !new Set(["GET", "HEAD"]).has(method);
    const headers = { accept: "application/json" };
    if (mutating) headers["x-csrf-token"] = csrfFromCookie(cookie());
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    return fetchCastingJsonV1(path, { method, headers,
      body: body === undefined ? undefined : JSON.stringify(body) }, { fetchImpl });
  }
  return Object.freeze({
    availability: async () => normalizeCastingAvailabilityV1(await request("/api/v1/casting/availability")),
    current: async () => normalizeCastingSessionV1(await request("/api/v1/casting/sessions/current")),
    get: async (sessionId) => normalizeCastingSessionV1(await request(`/api/v1/casting/sessions/${sessionId}`)),
    invitations: async () => normalizeCastingInvitationsV1(await request("/api/v1/casting/invitations")),
    viewers: async (sessionId) => normalizeCastingViewersV1(await request(`/api/v1/casting/sessions/${sessionId}/viewers`)),
    start: async (body) => normalizeCastingSessionV1(await request("/api/v1/casting/sessions", {
      method: "POST", body, idempotencyKey: `cast-start:${randomUUID()}`,
    })),
    update: async (sessionId, body) => normalizeCastingSessionV1(await request(`/api/v1/casting/sessions/${sessionId}/audience`, { method: "PATCH", body })),
    stop: async (sessionId) => normalizeCastingSessionV1(await request(`/api/v1/casting/sessions/${sessionId}/stop`, { method: "POST", body: {} })),
    forceStop: async (sessionId) => normalizeCastingSessionV1(await request(`/api/v1/casting/sessions/${sessionId}/force-stop`, { method: "POST", body: {} })),
    invite: async (sessionId, identityId) => normalizeCastingInvitationV1(await request(`/api/v1/casting/sessions/${sessionId}/invitations`, { method: "POST", body: { invitee_identity_id: identityId } })),
    accept: async (invitationId) => normalizeCastingInvitationV1(await request(`/api/v1/casting/invitations/${invitationId}/accept`, { method: "POST", body: {} })),
    decline: async (invitationId) => normalizeCastingInvitationV1(await request(`/api/v1/casting/invitations/${invitationId}/decline`, { method: "POST", body: {} })),
    join: async (sessionId, invitationId, browserInstanceId) => normalizeCastingJoinV1(await request(`/api/v1/casting/sessions/${sessionId}/join`, { method: "POST", body: {
      invitation_id: invitationId, browser_instance_id: browserInstanceId,
    } })),
    mediaConnection: async (sessionId, mediaCredential, browserInstanceId) => normalizeCastingMediaConnectionV1(
      await request(`/api/v1/casting/sessions/${sessionId}/media-connection`, { method: "POST", body: {
        media_credential: mediaCredential, browser_instance_id: browserInstanceId,
      } }),
    ),
    leave: async (sessionId, browserInstanceId) => normalizeCastingLeaveV1(await request(`/api/v1/casting/sessions/${sessionId}/leave`, {
      method: "POST", body: browserInstanceId === undefined ? {} : { browserInstanceId } })),
    removeViewer: async (sessionId, viewerIdentityId) => normalizeCastingRemoveViewerV1(await request(`/api/v1/casting/sessions/${sessionId}/viewers/${viewerIdentityId}/remove`, { method: "POST", body: {} })),
  });
}

export const castingClientPolicyV1 = Object.freeze({
  maximumViewers: null,
  supportedOutputs: Object.freeze(["browser"]),
  supportedAudiences: Object.freeze(["owner_only", "selected_users", "selected_team"]),
  invitationAutoplay: false,
  mediaCredentialPersistence: "memory-only",
  mediaAccessTokenPersistence: "memory-only",
  mediaReconnectPolicy: "fresh-explicit-join",
  recordingAllowed: false,
  userContentScreenshotsAllowed: false,
  indexingAllowed: false,
  objectStorePersistenceAllowed: false,
});

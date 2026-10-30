import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID_PART = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const SESSION = new RegExp(`^/api/v1/casting/sessions/${UUID_PART}$`, "i");
const AUDIENCE = new RegExp(`^/api/v1/casting/sessions/${UUID_PART}/audience$`, "i");
const STOP = new RegExp(`^/api/v1/casting/sessions/${UUID_PART}/stop$`, "i");
const FORCE_STOP = new RegExp(`^/api/v1/casting/sessions/${UUID_PART}/force-stop$`, "i");
const HEALTH = new RegExp(`^/api/v1/casting/sessions/${UUID_PART}/health$`, "i");
const SESSION_INVITATIONS = new RegExp(`^/api/v1/casting/sessions/${UUID_PART}/invitations$`, "i");
const JOIN = new RegExp(`^/api/v1/casting/sessions/${UUID_PART}/join$`, "i");
const MEDIA_CONNECTION = new RegExp(`^/api/v1/casting/sessions/${UUID_PART}/media-connection$`, "i");
const LEAVE = new RegExp(`^/api/v1/casting/sessions/${UUID_PART}/leave$`, "i");
const VIEWERS = new RegExp(`^/api/v1/casting/sessions/${UUID_PART}/viewers$`, "i");
const REMOVE_VIEWER = new RegExp(`^/api/v1/casting/sessions/${UUID_PART}/viewers/${UUID_PART}/remove$`, "i");
const ACCEPT = new RegExp(`^/api/v1/casting/invitations/${UUID_PART}/accept$`, "i");
const DECLINE = new RegExp(`^/api/v1/casting/invitations/${UUID_PART}/decline$`, "i");

const DEFAULT_DISABLED_STATUS = Object.freeze({
  schemaVersion: 1,
  object: "cast.availability",
  mode: "disabled",
  state: "unsupported",
  receiverReady: false,
  sessionStartAllowed: false,
  receiverAdvertisementAllowed: false,
  outputs: Object.freeze({
    browser: Object.freeze({ state: "unavailable", reasonCode: "casting_runtime_admission_not_configured" }),
  }),
  gates: Object.freeze([Object.freeze({
    code: "casting_runtime_admission_not_configured",
    category: "runtime",
    state: "blocked",
  })]),
  limitations: Object.freeze({
    appleCertified: false,
    fairPlayDrmSupported: false,
    syntheticAcceptanceAllowed: false,
  }),
  successor: Object.freeze({ atomicCutoverRequired: true }),
});

function idempotency(headers) {
  const value = headers?.["idempotency-key"];
  if (Array.isArray(value) || typeof value !== "string" || !value) {
    throw new PlatformError("cast_idempotency_required", "Idempotency-Key is required", { status: 400 });
  }
  return value;
}
function list(data) { return { object: "list", data }; }

function requestedOutputs(body) {
  // Do not turn an explicit null into an omitted browser default. Reject
  // ambiguous aliases before a stale client can reach the runtime.
  const snake = Object.hasOwn(body ?? {}, "output_sinks");
  const camel = Object.hasOwn(body ?? {}, "outputSinks");
  if (snake && camel) throw new PlatformError("cast_output_invalid", "Use only one output field", { status: 400 });
  const value = snake ? body.output_sinks : body?.outputSinks;
  if (value !== undefined && (!Array.isArray(value) || value.length !== 1 || value[0] !== "browser")) {
    throw new PlatformError("cast_output_invalid", "Casting is available only in the browser", { status: 400 });
  }
  return value;
}

export function matchesCastingHttpRoute(method, pathname) {
  if (pathname === "/api/v1/casting/availability") return method === "GET";
  if (pathname === "/api/v1/casting/sessions") return method === "POST";
  if (pathname === "/api/v1/casting/sessions/current") return method === "GET";
  if (pathname === "/api/v1/casting/invitations") return method === "GET";
  if (SESSION.test(pathname)) return method === "GET";
  if (AUDIENCE.test(pathname)) return method === "PATCH";
  if (STOP.test(pathname) || FORCE_STOP.test(pathname) || JOIN.test(pathname) || MEDIA_CONNECTION.test(pathname) || LEAVE.test(pathname)
    || REMOVE_VIEWER.test(pathname) || ACCEPT.test(pathname) || DECLINE.test(pathname)) return method === "POST";
  if (HEALTH.test(pathname) || VIEWERS.test(pathname)) return method === "GET";
  if (SESSION_INVITATIONS.test(pathname)) return method === "POST";
  return false;
}

export class CastingHttpApi {
  #service;
  #availability;
  #mediaAdmission;
  constructor({ service = null, availability = null, mediaAdmission = null }) {
    const required = ["startSession", "currentSession", "getSession", "updateAudience", "stopSession",
      "forceStop", "health", "createInvitation", "listInvitations", "acceptInvitation",
      "declineInvitation", "join", "createMediaConnection", "leave", "listViewers", "removeViewer"];
    if (service !== null && required.some((method) => typeof service[method] !== "function")) {
      throw new TypeError("casting HTTP service is incomplete");
    }
    if (availability !== null && (typeof availability.status !== "function"
        || typeof availability.assertSessionStartAllowed !== "function")) {
      throw new TypeError("casting availability source is incomplete");
    }
    if (service === null && availability === null) {
      throw new TypeError("casting HTTP API requires a service or availability source");
    }
    this.#service = service;
    this.#availability = availability;
    if (mediaAdmission !== null && typeof mediaAdmission.issue !== "function") {
      throw new TypeError("casting authenticated media admission is invalid");
    }
    this.#mediaAdmission = mediaAdmission;
  }

  matches(method, pathname) { return matchesCastingHttpRoute(method, pathname); }

  async handleSignOut({ context }) {
    return this.#service?.handleInitiatorSignOut?.(context?.identityId) ?? null;
  }

  async handle({ method, pathname, body = null, context, headers = {} }) {
    if (!context?.identityId) throw new PlatformError("invalid_session", "Authentication is required", { status: 401 });
    if (pathname === "/api/v1/casting/availability" && method === "GET") {
      return { kind: "json", status: 200,
        body: this.#availability === null ? DEFAULT_DISABLED_STATUS : await this.#availability.status() };
    }
    if (this.#service === null) await this.#availability.assertSessionStartAllowed();
    if (pathname === "/api/v1/casting/sessions" && method === "POST") {
      if (this.#availability === null) {
        throw new PlatformError("cast_capability_unavailable", "Wireless casting runtime admission is not configured", {
          status: 503,
          retryable: false,
          details: {
            state: "unsupported",
            receiverReady: false,
            startAllowed: false,
            gateCodes: ["casting_runtime_admission_not_configured"],
          },
        });
      }
      await this.#availability.assertSessionStartAllowed();
      return { kind: "json", status: 201, body: await this.#service.startSession({
        context, input: {
          outputSinks: requestedOutputs(body),
          browserAudience: body?.browser_audience ?? body?.browserAudience ?? null,
          viewerUserIds: body?.viewer_user_ids ?? body?.viewerUserIds ?? [],
          viewerTeamId: body?.viewer_team_id ?? body?.viewerTeamId ?? null,
          ttlSeconds: body?.ttl_seconds ?? body?.ttlSeconds,
        }, idempotencyKey: idempotency(headers),
      }) };
    }
    if (pathname === "/api/v1/casting/sessions/current" && method === "GET") {
      return { kind: "json", status: 200, body: await this.#service.currentSession({ context }) };
    }
    if (pathname === "/api/v1/casting/invitations" && method === "GET") {
      return { kind: "json", status: 200, body: list(await this.#service.listInvitations({ context })) };
    }
    const detail = SESSION.exec(pathname);
    if (detail && method === "GET") return { kind: "json", status: 200,
      body: await this.#service.getSession({ context, sessionId: detail[1] }) };
    const audience = AUDIENCE.exec(pathname);
    if (audience && method === "PATCH") return { kind: "json", status: 200,
      body: await this.#service.updateAudience({ context, sessionId: audience[1], input: {
        outputSinks: requestedOutputs(body),
        browserAudience: body?.browser_audience ?? body?.browserAudience ?? null,
        viewerUserIds: body?.viewer_user_ids ?? body?.viewerUserIds ?? [],
        viewerTeamId: body?.viewer_team_id ?? body?.viewerTeamId ?? null,
      } }) };
    const stop = STOP.exec(pathname);
    if (stop && method === "POST") return { kind: "json", status: 200,
      body: await this.#service.stopSession({ context, sessionId: stop[1] }) };
    const forceStop = FORCE_STOP.exec(pathname);
    if (forceStop && method === "POST") return { kind: "json", status: 200,
      body: await this.#service.forceStop({ context, sessionId: forceStop[1] }) };
    const health = HEALTH.exec(pathname);
    if (health && method === "GET") return { kind: "json", status: 200,
      body: await this.#service.health({ context, sessionId: health[1] }) };
    const invitations = SESSION_INVITATIONS.exec(pathname);
    if (invitations && method === "POST") return { kind: "json", status: 201,
      body: await this.#service.createInvitation({ context, sessionId: invitations[1],
        inviteeIdentityId: body?.invitee_identity_id ?? body?.inviteeIdentityId }) };
    const accept = ACCEPT.exec(pathname);
    if (accept && method === "POST") return { kind: "json", status: 200,
      body: await this.#service.acceptInvitation({ context, invitationId: accept[1] }) };
    const decline = DECLINE.exec(pathname);
    if (decline && method === "POST") return { kind: "json", status: 200,
      body: await this.#service.declineInvitation({ context, invitationId: decline[1] }) };
    const join = JOIN.exec(pathname);
    if (join && method === "POST") return { kind: "json", status: 200,
      body: await this.#service.join({ context, sessionId: join[1],
        invitationId: body?.invitation_id ?? body?.invitationId ?? null,
        browserInstanceId: body?.browser_instance_id ?? body?.browserInstanceId }) };
    const mediaConnection = MEDIA_CONNECTION.exec(pathname);
    if (mediaConnection && method === "POST") {
      // Never return a direct SFU bearer when the authenticated one-use WSS
      // boundary is absent. A healthy receiver is not sufficient admission.
      if (!this.#mediaAdmission) throw new PlatformError("cast_media_connection_unavailable",
        "Authenticated casting media ingress is not configured", { status: 503, retryable: false });
      return { kind: "json", status: 200,
      body: await this.#mediaAdmission.issue({ context, sessionId: mediaConnection[1],
        browserInstanceId: body?.browser_instance_id ?? body?.browserInstanceId,
        mediaCredential: body?.media_credential ?? body?.mediaCredential }) };
    }
    const leave = LEAVE.exec(pathname);
    if (leave && method === "POST") return { kind: "json", status: 200,
      body: await this.#service.leave({ context, sessionId: leave[1],
        browserInstanceId: body?.browser_instance_id ?? body?.browserInstanceId }) };
    const viewers = VIEWERS.exec(pathname);
    if (viewers && method === "GET") return { kind: "json", status: 200,
      body: list(await this.#service.listViewers({ context, sessionId: viewers[1] })) };
    const remove = REMOVE_VIEWER.exec(pathname);
    if (remove && method === "POST") return { kind: "json", status: 200,
      body: await this.#service.removeViewer({ context, sessionId: remove[1], viewerIdentityId: remove[2] }) };
    throw new PlatformError("not_found", "Casting endpoint was not found", { status: 404 });
  }
}

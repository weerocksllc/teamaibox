import { ApplianceAgentHttpApi } from "../src/appliance/appliance-agent-http-api.mjs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { castingCallbackConfigured, createCastingCallbackRuntimeFromEnvironment } from "./casting-callback-runtime.mjs";
import { RuntimeCastingAvailability } from "../src/casting/runtime-casting-availability.mjs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { bufferedMediaResponse, createBufferedMediaAccount } from "../../../services/object-service/src/buffered-media-budget.mjs";

import {
  correlationIdFromRequest,
  createStructuredLogger,
  errorResponse,
  PlatformError,
  runWithCorrelation,
} from "../../../packages/observability/src/index.mjs";
import { LocalAuthentication } from "../src/identity/auth-service.mjs";
import {
  clearCsrfCookie,
  clearSessionCookie,
  csrfCookie,
  readCsrfCookie,
  readSessionCookie,
  sessionCookie,
} from "../src/identity/http-session.mjs";
import { MemoryIdentityRepository } from "../src/identity/memory-repository.mjs";
import { PostgresIdentityRepository } from "../src/identity/postgres-repository.mjs";
import { IdentityPreferencesService } from "../src/identity/preferences-service.mjs";
import { IdentityDirectoryService } from "../src/identity/identity-directory-service.mjs";
import { IdentityDirectoryHttpApi } from "../src/identity/identity-directory-http-api.mjs";
import { IdentityAdministrationService } from "../src/identity/identity-administration-service.mjs";
import { IdentityAdministrationHttpApi } from "../src/identity/identity-administration-http-api.mjs";
import { OwnerSetupTokenAuthority } from "../src/identity/setup-authority.mjs";
import { OwnerRecoveryAuthorityError, OwnerRecoveryProofAuthority } from "../src/identity/owner-recovery-authority.mjs";
import { ApiCredentialService } from "../src/identity/api-credential-service.mjs";
import { CredentialHttpApi } from "../src/identity/credential-http-api.mjs";
import { MemoryCredentialRepository } from "../src/identity/memory-credential-repository.mjs";
import { PostgresCredentialRepository } from "../src/identity/postgres-credential-repository.mjs";
import { RoutedCredentialAuthentication } from "../src/identity/routed-credential-authentication.mjs";
import { AssistantHttpApi } from "../src/assistant/assistant-http-api.mjs";
import { AssistantService } from "../src/assistant/assistant-service.mjs";
import { AssistantArtifactHandoff } from "../src/assistant/artifact-handoff.mjs";
import { MemoryAssistantRepository } from "../src/assistant/memory-repository.mjs";
import { PostgresAssistantRepository } from "../src/assistant/postgres-repository.mjs";
import { fixedAssistantRoutingPolicy, OpenAiQueuedAnswerRunner } from "../src/assistant/openai-answer-runner.mjs";
import { QueuedAssistantAnswerRunner } from "../src/assistant/queued-answer-runner.mjs";
import { createDynamicAgentRoutes } from "../src/assistant/dynamic-agent-routes.mjs";
import {
  loadAssistantAgentBridgeRoutes,
  OpenCodeAssistantAgentRunner,
} from "../src/assistant/opencode-agent-runner.mjs";
import { TeamDriveHttpApi } from "../src/files/team-drive-http-api.mjs";
import { MemoryTaskCenterRepository } from "../src/tasks/memory-repository.mjs";
import { PostgresAgentTaskCenterRepository } from "../src/tasks/postgres-agent-task-center-repository.mjs";
import { TaskCenter } from "../src/tasks/task-center.mjs";
import { CatalogUserServiceAvailabilitySource, ClusterUserServiceAvailabilitySource, UserActivityService } from "../src/tasks/user-activity-service.mjs";
import { UserActivityHttpApi } from "../src/tasks/user-activity-http-api.mjs";
import { ApplicationCatalogService } from "../src/applications/application-catalog-service.mjs";
import { ApplicationCatalogHttpApi } from "../src/applications/application-catalog-http-api.mjs";
import { CompositeApplicationRouteSource } from "../src/applications/composite-application-route-source.mjs";
import { FileApplicationRouteSource } from "../src/applications/file-application-route-source.mjs";
import { FileBuiltInApplicationSource } from "../src/applications/file-built-in-application-source.mjs";
import { PostgresApplicationCatalogRepository } from "../src/applications/postgres-application-catalog-repository.mjs";
import { ProtectedOfficeCatalogRepository, protectedOfficeCatalogProfiles } from "../src/applications/protected-office-catalog-repository.mjs";
import { MessagingHttpApi } from "../src/messaging/messaging-http-api.mjs";
import { CastingHttpApi } from "../src/casting/casting-http-api.mjs";
import { VirtualPhoneHttpApi } from "../src/virtual-phones/virtual-phone-http-api.mjs";
import { VirtualPhoneService } from "../src/virtual-phones/virtual-phone-service.mjs";
import { computersFromEnvironment } from "../src/virtual-computers/computer-composition.mjs";
import { phoneCapacityFromEnvironment, phoneRuntimeFromEnvironment, phoneMediaFromEnvironment, phoneFilesFromEnvironment, phoneStorageRepositoryFromEnvironment, phoneCameraFromEnvironment, phoneAccessRevoker } from "../src/virtual-phones/phone-capacity-composition.mjs";
import { phoneSystemReleasesFromEnvironment } from '../src/virtual-phones/phone-system-catalog.mjs';
import {PhoneFileService} from '../src/virtual-phones/phone-file-service.mjs';
import {PhoneObjectTransfer} from '../src/virtual-phones/phone-object-transfer.mjs';
import { PostgresPhoneRepository } from "../src/virtual-phones/postgres-phone-repository.mjs";
import { PostgresPhoneAccessRepository } from "../src/virtual-phones/postgres-phone-access-repository.mjs";
import { PhoneAccessService } from "../src/virtual-phones/phone-access-service.mjs";
import { castingMediaSignallingConfigured, createCastingMediaBoundaryFromEnvironment } from "./casting-media-boundary.mjs";
import { CastingSessionService } from "../src/casting/casting-session-service.mjs";
import { MemoryCastingEphemeralStore } from "../src/casting/memory-casting-ephemeral-store.mjs";
import { MemoryCastingRepository } from "../src/casting/memory-casting-repository.mjs";
import { PostgresCastingRepository } from "../src/casting/postgres-casting-repository.mjs";
import { RepositoryCastingIdentityDirectory } from "../src/casting/repository-casting-identity-directory.mjs";
import { MessagingService } from "../../../services/messaging/src/messaging-service.mjs";
import { MemoryMessagingRepository } from "../../../services/messaging/src/memory-repository.mjs";
import { PostgresMessagingRepository } from "../../../services/messaging/src/postgres-repository.mjs";
import { FileDisabledCastingAvailability } from "../src/casting/file-disabled-casting-availability.mjs";
import { createCastingSessionRuntime } from "./casting-session-runtime.mjs";
import {
  createTrustedMediaRuntimeFromEnvironment,
  trustedMediaRuntimeConfigured,
} from "./trusted-media-runtime.mjs";
import {
  ComputeHttpApi,
  matchesComputeHttpRoute,
  matchesComputeRealtimeRoute,
} from "../src/compute/compute-http-api.mjs";
import { DurableComputeBackend, DurableJobService } from "../src/compute/durable-job-service.mjs";
import { ObjectJobPayloadStore } from "../src/compute/job-payload-store.mjs";
import { ComputeArtifactHandoff } from "../src/compute/artifact-handoff.mjs";
import { OpenAiWorkerExecutionBridge } from "../src/compute/openai-worker-execution-bridge.mjs";
import {
  AgentComputeCredentialAuthentication,
  AgentModelCredentialAuthority,
  loadAgentModelAliasMap,
  loadAgentModelSigningKey,
} from "../../../services/compute-gateway/src/agent-model-credential.mjs";
import { PostgresDurableJobRepository } from "../src/compute/postgres-durable-job-repository.mjs";
import { PostgresProtectedLocalAttemptRepository } from "../src/compute/postgres-protected-local-attempt-repository.mjs";
import { PostgresExternalAttemptRepository } from "../../../services/scheduler/src/postgres-external-attempt-repository.mjs";
import { PostgresQueueAdministrationRepository } from "../src/queues/postgres-queue-administration-repository.mjs";
import { QueueAdministrationService } from "../src/queues/queue-administration-service.mjs";
import { QueueAdministrationHttpApi } from "../src/queues/queue-administration-http-api.mjs";
import { PostgresStorageAdministrationRepository } from "../src/storage/postgres-storage-administration-repository.mjs";
import { StorageAdministrationService } from "../src/storage/storage-administration-service.mjs";
import { StorageAdministrationHttpApi } from "../src/storage/storage-administration-http-api.mjs";
import { EncryptionAdministrationService, EnvironmentEncryptionRuntimeStatusSource } from "../src/encryption/encryption-administration-service.mjs";
import { EncryptionAdministrationHttpApi } from "../src/encryption/encryption-administration-http-api.mjs";
import { PostgresEncryptionAdministrationRepository } from "../src/encryption/postgres-encryption-administration-repository.mjs";
import { createModelAdministration } from "../src/models/model-administration.mjs";
import { ObjectHttpApi } from "../src/objects/object-http-api.mjs";
import { teamDriveReferenceAccess } from "../src/objects/team-drive-reference-access.mjs";
import { PostgresObjectGrantRepository } from "../../../services/object-service/src/postgres-object-grant-repository.mjs";
import { ArtifactProvenanceService } from "../../../services/object-service/src/artifact-provenance-service.mjs";
import { MemoryArtifactProvenanceRepository } from "../../../services/object-service/src/memory-artifact-provenance-repository.mjs";
import { PostgresArtifactProvenanceRepository } from "../../../services/object-service/src/postgres-artifact-provenance-repository.mjs";
import { RemoteProtectedObjectService } from "../../../services/object-service/src/internal-rpc-client.mjs";
import { PostgresFileRepository } from "../../../services/object-service/src/postgres-file-repository.mjs";
import { TeamDriveArtifactHandoff } from "../../../services/object-service/src/team-drive-artifact-handoff.mjs";
import { TeamDriveService } from "../../../services/object-service/src/team-drive-service.mjs";
import { SourceCenterHttpApi } from "../src/sources/source-center-http-api.mjs";
import { SourceDataPlaneStatusProvider } from "../src/sources/source-data-plane-status.mjs";
import { OfflineMediaHttpApi } from "../src/sources/offline-media-http-api.mjs";
import { RealtimeWebSocketSpeechSession } from "./realtime-websocket-session.mjs";
import { OperationsDashboardService } from "../src/operations/operations-dashboard-service.mjs";
import { OperationsHttpApi } from "../src/operations/operations-http-api.mjs";
import { OperationalDiagnosticsService } from "../src/operations/operational-diagnostics-service.mjs";
import { MemoryObservabilityRepository } from "../src/operations/memory-observability-repository.mjs";
import { PostgresObservabilityRepository } from "../src/operations/postgres-observability-repository.mjs";
import { AuditHttpApi } from "../src/audit/audit-http-api.mjs";
import { MemoryAuditRepository } from "../src/audit/memory-audit-repository.mjs";
import { PostgresAuditRepository } from "../src/audit/postgres-audit-repository.mjs";
import { HmacAuditSigner, TamperEvidentAuditService } from "../src/audit/tamper-evident-audit-service.mjs";
import { PluginAdministrationHttpApi } from "../src/plugins/plugin-administration-http-api.mjs";
import { PluginAccessHttpApi } from "../src/plugins/plugin-access-http-api.mjs";
import { DelegatedPluginOperationDispatcher } from "../src/plugins/delegated-operation-dispatcher.mjs";
import { MaintenanceHttpApi } from "../src/updates/maintenance-http-api.mjs";
import { MaintenanceWorkflowService } from "../src/updates/maintenance-workflow-service.mjs";
import { MemoryMaintenanceRepository } from "../src/updates/memory-maintenance-repository.mjs";
import { PostgresMaintenanceRepository } from "../src/updates/postgres-maintenance-repository.mjs";
import { ManagedNodeReconciler } from "../../../services/scheduler/src/managed-node-reconciler.mjs";
import { ClusterMetricService } from "../../../services/scheduler/src/cluster-metric-service.mjs";
import { PostgresClusterMetricRepository } from "../../../services/scheduler/src/postgres-cluster-metric-repository.mjs";
import { PostgresManagedNodeRepository } from "../../../services/scheduler/src/postgres-managed-node-repository.mjs";
import {
  createApplianceRuntimeFromEnvironment,
  applianceRuntimeConfigured,
} from "./appliance-runtime.mjs";
import { createProtectedOfficeSetControlHandler } from "./protected-office-set-deployment-runtime.mjs";
import { SourceCenterService } from "../../../services/source-gateway/src/source-center-service.mjs";
import { MemorySourceCenterRepository } from "../../../services/source-gateway/src/memory-source-center-repository.mjs";
import { PostgresSourceCenterRepository } from "../../../services/source-gateway/src/postgres-source-center-repository.mjs";
import { OfflineMediaService } from "../../../services/source-gateway/src/offline-media-service.mjs";
import { MemoryOfflineMediaRepository } from "../../../services/source-gateway/src/memory-offline-media-repository.mjs";
import { PostgresOfflineMediaRepository } from "../../../services/source-gateway/src/postgres-offline-media-repository.mjs";
import { ProviderHttpApi } from "../src/providers/provider-http-api.mjs";
import { ExternalProviderService } from "../src/providers/external-provider-service.mjs";
import { MemoryExternalProviderRepository } from "../src/providers/memory-provider-repository.mjs";
import { PostgresExternalProviderRepository } from "../src/providers/postgres-provider-repository.mjs";
import { ExternalProviderExecutionRouter } from "../src/providers/external-provider-execution-router.mjs";
import { ExternalProviderHealthMonitor } from "../src/providers/external-provider-health-monitor.mjs";
import { ExternalProviderContractTester } from "../../../services/scheduler/src/external-provider-contract-tester.mjs";
import { RoutingPolicyHttpApi } from "../src/providers/routing-policy-http-api.mjs";
import { RoutingPolicyRegistry } from "../../../services/scheduler/src/routing-policy-registry.mjs";
import { MemoryRoutingPolicyRepository } from "../../../services/scheduler/src/memory-routing-policy-repository.mjs";
import { PostgresRoutingPolicyRepository } from "../../../services/scheduler/src/postgres-routing-policy-repository.mjs";
import { AgentSessionService } from "../../../services/agent-bridge/src/agent-session-service.mjs";
import { PostgresAgentSessionRepository } from "../../../services/agent-bridge/src/postgres-session-repository.mjs";
import { ExternalObjectProxyHttpApi } from "../src/providers/external-object-proxy-http-api.mjs";
import { ExternalObjectTransferService } from "../../../services/scheduler/src/external-object-transfer-service.mjs";
import { MemoryExternalObjectGrantRepository } from "../../../services/scheduler/src/memory-external-object-grant-repository.mjs";
import { PostgresExternalObjectGrantRepository } from "../../../services/scheduler/src/postgres-external-object-grant-repository.mjs";

const MAX_BODY_BYTES = 16 * 1024;
// These authenticated APIs use measured process/container memory rather than
// product byte quotas. The small sign-in envelope above remains independent.
const MAX_COMPUTE_BODY_BYTES = null;
const MAX_OBJECT_BODY_BYTES = null;
const MAX_PROTECTED_OFFICE_CONTROL_BODY_BYTES = null;
const AUTHENTICATED_PATHS = new Set([
  "/api/auth/sign-out",
  "/api/auth/recovery-codes/rotate",
  "/api/preferences/locale",
  "/api/preferences/theme",
  "/events/session",
  "/ws/session",
]);

function safeOrigin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("platform public origin must be an HTTPS origin");
  }
  return parsed.origin;
}

function requestPath(request) {
  try {
    return new URL(request.url || "/", "http://platform-api.invalid").pathname;
  } catch {
    return null;
  }
}

function requestQuery(request) {
  try {
    return new URL(request.url || "/", "http://platform-api.invalid").searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function forwardedSecure(request) {
  return request.socket.encrypted === true || request.headers["x-forwarded-proto"] === "https";
}

export function managedNodeTransportIdentity(request) {
  const socket = request?.socket;
  if (socket?.encrypted !== true || socket.authorized !== true || typeof socket.getPeerCertificate !== "function") {
    throw new PlatformError("managed_node_mtls_required", "Verified mutual TLS node identity is required", { status: 401 });
  }
  const certificate = socket.getPeerCertificate(false);
  const san = String(certificate?.subjectaltname ?? "");
  const match = /(?:^|,\s*)URI:spiffe:\/\/teamaibox\.local\/node\/([0-9a-f-]{36})(?:,|$)/i.exec(san);
  const fingerprintHex = String(certificate?.fingerprint256 ?? "").replaceAll(":", "").toLowerCase();
  if (!match || !/^[0-9a-f]{64}$/.test(fingerprintHex)) {
    throw new PlatformError("managed_node_certificate_rejected", "Managed node certificate identity is invalid", { status: 401 });
  }
  return Object.freeze({ mutualTls: true, certificateVerified: true, subjectNodeId: match[1].toLowerCase(), certificateFingerprint: `sha256:${fingerprintHex}` });
}

function requireSecureTransport(request) {
  if (!forwardedSecure(request)) {
    throw new PlatformError("https_required", "Authentication requires HTTPS", { status: 426 });
  }
}

function requireSameOrigin(request, publicOrigin) {
  if (request.headers.origin !== publicOrigin) {
    throw new PlatformError("origin_denied", "Request origin is not allowed", { status: 403 });
  }
}

function applyApiHeaders(response, requestId) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("x-request-id", requestId);
}

function jsonResponse(response, requestId, status, body, headers = {}) {
  applyApiHeaders(response, requestId);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

// Heartbeat/control messages still obey actual heap/cgroup headroom, but must
// not wait behind a file transfer's estimated future buffer copies.
const nodeControlMemory = createBufferedMediaAccount();
async function jsonBody(request, maximumBytes = MAX_BODY_BYTES, memoryOptions = {}) {
  if (!(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    throw new PlatformError("unsupported_media_type", "Content-Type must be application/json", { status: 415 });
  }
  if (maximumBytes === null) {
    const bytes = await resourceBody(request, memoryOptions);
    try {
      const value = JSON.parse(bytes.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
      return value;
    } catch { throw new PlatformError('invalid_json', 'Request body is invalid', {status:400}); }
    finally { bytes.fill(0); }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new PlatformError("request_too_large", "Request body is too large", { status: 413 });
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value;
  } catch {
    throw new PlatformError("invalid_json", "Request body is invalid", { status: 400 });
  }
}

async function byteBody(request, maximumBytes = MAX_OBJECT_BODY_BYTES) {
  if (maximumBytes === null) {
    const bytes = await resourceBody(request);
    if (!bytes.length) throw new PlatformError('invalid_object_content', 'Object content is required', {status:400});
    return bytes;
  }
  const declared = Number(request.headers["content-length"] || 0);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new PlatformError("request_too_large", "Request body is too large", { status: 413 });
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new PlatformError("request_too_large", "Request body is too large", { status: 413 });
    chunks.push(chunk);
  }
  if (size < 1) throw new PlatformError("invalid_object_content", "Object content is required", { status: 400 });
  return Buffer.concat(chunks);
}

async function resourceBody(request, memoryOptions = {}) {
  const length = request.headers['content-length'];
  return bufferedMediaResponse(new Response(Readable.toWeb(request), {
    headers: length == null ? {} : {'content-length': length},
  }), memoryOptions);
}

function csrfHeader(request) {
  const value = request.headers["x-csrf-token"];
  if (Array.isArray(value)) return null;
  return typeof value === "string" ? value : null;
}

function sessionToken(request) {
  return readSessionCookie(request.headers.cookie || "");
}

async function authenticatedContext(request, authentication, { csrf = false } = {}) {
  requireSecureTransport(request);
  return authentication.authenticateSession({
    sessionToken: sessionToken(request),
    csrfToken: csrf ? csrfHeader(request) : null,
    requireCsrf: csrf,
  });
}

function authorizationHeader(request) {
  const occurrences = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === "authorization") occurrences.push(request.rawHeaders[index + 1]);
  }
  if (occurrences.length > 1) {
    throw new PlatformError("invalid_credential", "Credential is invalid or expired", { status: 401 });
  }
  return occurrences[0] ?? null;
}

async function computeContext(request, {
  authentication,
  credentialAuthentication,
  publicOrigin,
  stateChanging,
  operation,
}) {
  requireSecureTransport(request);
  const authorization = authorizationHeader(request);
  if (authorization !== null) {
    const match = /^Bearer ([^\s,]{16,4096})$/.exec(authorization);
    if (!match || !credentialAuthentication) {
      throw new PlatformError("invalid_credential", "Credential is invalid or expired", { status: 401 });
    }
    return credentialAuthentication.authenticate({
      secret: match[1],
      permission: "ai:invoke",
      resource: { kind: "appliance", key: "*" },
      operation,
    });
  }
  if (stateChanging) requireSameOrigin(request, publicOrigin);
  const context = await authenticatedContext(request, authentication, { csrf: stateChanging });
  if (!context.permissions?.includes("ai:invoke")) {
    throw new PlatformError("access_denied", "This account cannot invoke AI capabilities", { status: 403 });
  }
  return context;
}

async function administrativeContext(request, { authentication, publicOrigin, stateChanging }) {
  requireSecureTransport(request);
  if (stateChanging) requireSameOrigin(request, publicOrigin);
  return authenticatedContext(request, authentication, { csrf: stateChanging });
}

function networkIdentifier(request) {
  const forwarded = request.headers["x-forwarded-for"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return String(value || request.socket.remoteAddress || "unknown").slice(0, 256);
}

function websocketTextFrame(value) {
  const payload = Buffer.from(value, "utf8");
  if (payload.length <= 125) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length <= 65_535) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  throw new TypeError("WebSocket bootstrap frame is too large");
}

function websocketAccept(key) {
  let decoded;
  try {
    decoded = Buffer.from(key, "base64");
  } catch {
    return null;
  }
  if (decoded.length !== 16) return null;
  return createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}

function rejectUpgrade(socket, status, message) {
  socket.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function openAiErrorResponse(error, requestId) {
  const failure = errorResponse(error, requestId);
  const source = failure.body.error;
  const type = failure.status === 401
    ? "authentication_error"
    : failure.status === 403
      ? "permission_error"
      : failure.status === 429
        ? "rate_limit_error"
        : failure.status >= 500
          ? "api_error"
          : "invalid_request_error";
  return {
    status: failure.status,
    body: {
      error: {
        message: source.message,
        type,
        param: source.details?.param ?? null,
        code: source.code,
        x_teamaibox: {
          retryable: source.retryable,
          correlation_id: requestId,
        },
      },
    },
  };
}

async function sseResponse(request, response, requestId, result) {
  applyApiHeaders(response, requestId);
  response.writeHead(result.status, {
    "content-type": "text/event-stream; charset=utf-8",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  // EventSource considers the connection open as soon as the response headers
  // arrive.  Flush them before awaiting the first application event so an
  // idle, healthy stream does not look permanently stuck in "connecting".
  response.flushHeaders?.();
  try {
    for await (const item of result.events) {
      if (response.destroyed) break;
      if (!item || typeof item !== "object" || Array.isArray(item) || !("data" in item)) {
        throw new PlatformError("compute_backend_invalid", "Compute stream returned an invalid event", { status: 502 });
      }
      if (item.id !== undefined) {
        if (typeof item.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(item.id)) {
          throw new PlatformError("compute_backend_invalid", "Compute stream returned an invalid event identifier", { status: 502 });
        }
        response.write(`id: ${item.id}\n`);
      }
      if (item.event !== undefined) {
        if (typeof item.event !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(item.event)) {
          throw new PlatformError("compute_backend_invalid", "Compute stream returned an invalid event type", { status: 502 });
        }
        response.write(`event: ${item.event}\n`);
      }
      response.write(`data: ${JSON.stringify(item.data)}\n\n`);
    }
    if (!response.destroyed && result.doneMarker) response.write(`data: ${result.doneMarker}\n\n`);
    if (!response.destroyed) response.end();
  } catch (error) {
    if (!response.destroyed) response.destroy(error);
  }
}

function nonJsonResponse(response, requestId, result) {
  applyApiHeaders(response, requestId);
  response.writeHead(result.status, result.headers || {});
  if (result.kind === "empty") response.end();
  else response.end(result.body);
}

export function createPlatformApiServer({
  authentication,
  preferences,
  publicOrigin,
  logger = null,
  computeApi = null,
  assistantApi = null,
  modelLifecycleApi = null,
  sourceCenterApi = null,
  offlineMediaApi = null,
  providerApi = null,
  routingPolicyApi = null,
  externalObjectProxyApi = null,
  applianceAgentApi = null,
  operationsApi = null,
  queueAdministrationApi = null,
  storageAdministrationApi = null,
  encryptionAdministrationApi = null,
  auditApi = null,
  pluginAdministrationApi = null,
  pluginAccessApi = null,
  maintenanceApi = null,
  userActivityApi = null,
  applicationCatalogApi = null,
  identityDirectoryApi = null,
  identityAdministrationApi = null,
  credentialApi = null,
  messagingApi = null,
  castingApi = null,
  virtualPhoneApi = null,
  virtualPhoneMediaGateway = null,
  computerDesktopApi = null,
  virtualComputerApi = null,
  castingMediaGateway = null,
  protectedOfficeSetControlHandler = null,
  nodeTransportIdentityResolver = managedNodeTransportIdentity,
  teamDriveApi = null,
  objectApi = null,
  credentialAuthentication = null,
  ownerSetupAuthority = null,
  ownerRecoveryAuthority = null,
  realtimeSpeechTransport = null,
}) {
  if (!authentication || !preferences) throw new TypeError("authentication and preferences services are required");
  if (virtualComputerApi !== null && !['matches','handle'].every(k=>typeof virtualComputerApi[k]==='function')) throw new TypeError('Computer API is invalid');
  if (computerDesktopApi !== null && !['matches', 'handle', 'attachUpgrade', 'close', 'handleSignOut']
    .every(key => typeof computerDesktopApi[key] === 'function')) throw new TypeError('Computer desktop API is invalid');
  if (virtualPhoneApi !== null && (typeof virtualPhoneApi.matches !== "function" || typeof virtualPhoneApi.handle !== "function")) {
    throw new TypeError("Virtual phone API is invalid");
  }
  if (virtualPhoneMediaGateway !== null && (typeof virtualPhoneMediaGateway.attachUpgrade !== "function" || typeof virtualPhoneMediaGateway.close !== "function")) {
    throw new TypeError("Virtual phone media gateway is invalid");
  }
  if (computeApi !== null && (typeof computeApi.matches !== "function" || typeof computeApi.handle !== "function")) {
    throw new TypeError("compute API is invalid");
  }
  if (assistantApi !== null && (typeof assistantApi.matches !== "function" || typeof assistantApi.handle !== "function")) {
    throw new TypeError("assistant API is invalid");
  }
  if (modelLifecycleApi !== null && (typeof modelLifecycleApi.matches !== "function" || typeof modelLifecycleApi.handle !== "function")) {
    throw new TypeError("model lifecycle API is invalid");
  }
  if (sourceCenterApi !== null && (typeof sourceCenterApi.matches !== "function" || typeof sourceCenterApi.handle !== "function")) {
    throw new TypeError("Source Center API is invalid");
  }
  if (offlineMediaApi !== null && (typeof offlineMediaApi.matches !== "function" || typeof offlineMediaApi.handle !== "function")) {
    throw new TypeError("Offline media API is invalid");
  }
  if (providerApi !== null && (typeof providerApi.matches !== "function" || typeof providerApi.handle !== "function")) {
    throw new TypeError("external provider API is invalid");
  }
  if (routingPolicyApi !== null && (typeof routingPolicyApi.matches !== "function" || typeof routingPolicyApi.handle !== "function")) {
    throw new TypeError("routing policy API is invalid");
  }
  if (externalObjectProxyApi !== null && (typeof externalObjectProxyApi.matches !== "function"
      || typeof externalObjectProxyApi.handle !== "function" || typeof externalObjectProxyApi.bodyKind !== "function")) {
    throw new TypeError("external object proxy API is invalid");
  }
  if (applianceAgentApi !== null && (typeof applianceAgentApi.matches !== "function" || typeof applianceAgentApi.routeKind !== "function" || typeof applianceAgentApi.handle !== "function")) {
    throw new TypeError("appliance agent API is invalid");
  }
  if (operationsApi !== null && (typeof operationsApi.matches !== "function" || typeof operationsApi.handle !== "function")) {
    throw new TypeError("operations API is invalid");
  }
  if (queueAdministrationApi !== null && (typeof queueAdministrationApi.matches !== "function" || typeof queueAdministrationApi.handle !== "function")) {
    throw new TypeError("queue administration API is invalid");
  }
  if (storageAdministrationApi !== null && (typeof storageAdministrationApi.matches !== "function" || typeof storageAdministrationApi.handle !== "function")) {
    throw new TypeError("storage administration API is invalid");
  }
  if (encryptionAdministrationApi !== null && (typeof encryptionAdministrationApi.matches !== "function" || typeof encryptionAdministrationApi.handle !== "function")) {
    throw new TypeError("encryption administration API is invalid");
  }
  if (auditApi !== null && (typeof auditApi.matches !== "function" || typeof auditApi.handle !== "function")) {
    throw new TypeError("audit API is invalid");
  }
  if (pluginAdministrationApi !== null && (typeof pluginAdministrationApi.matches !== "function" || typeof pluginAdministrationApi.handle !== "function")) {
    throw new TypeError("plugin administration API is invalid");
  }
  if (pluginAccessApi !== null && (typeof pluginAccessApi.matches !== "function" || typeof pluginAccessApi.routeKind !== "function" || typeof pluginAccessApi.handle !== "function")) {
    throw new TypeError("plugin access API is invalid");
  }
  if (maintenanceApi !== null && (typeof maintenanceApi.matches !== "function" || typeof maintenanceApi.handle !== "function")) {
    throw new TypeError("maintenance API is invalid");
  }
  if (userActivityApi !== null && (typeof userActivityApi.matches !== "function" || typeof userActivityApi.handle !== "function")) {
    throw new TypeError("user activity API is invalid");
  }
  if (applicationCatalogApi !== null && (typeof applicationCatalogApi.matches !== "function" || typeof applicationCatalogApi.handle !== "function")) {
    throw new TypeError("application catalog API is invalid");
  }
  if (identityDirectoryApi !== null && (typeof identityDirectoryApi.matches !== "function" || typeof identityDirectoryApi.handle !== "function")) {
    throw new TypeError("identity directory API is invalid");
  }
  if (identityAdministrationApi !== null && (typeof identityAdministrationApi.matches !== "function" || typeof identityAdministrationApi.handle !== "function")) {
    throw new TypeError("identity administration API is invalid");
  }
  if (credentialApi !== null && (typeof credentialApi.matches !== "function" || typeof credentialApi.handle !== "function")) {
    throw new TypeError("credential API is invalid");
  }
  if (messagingApi !== null && (typeof messagingApi.matches !== "function" || typeof messagingApi.handle !== "function")) {
    throw new TypeError("messaging API is invalid");
  }
  if (castingApi !== null && (typeof castingApi.matches !== "function" || typeof castingApi.handle !== "function")) {
    throw new TypeError("casting API is invalid");
  }
  if (castingMediaGateway !== null && (typeof castingMediaGateway.attachUpgrade !== "function"
      || typeof castingMediaGateway.close !== "function")) throw new TypeError("casting media gateway is invalid");
  if (protectedOfficeSetControlHandler !== null
      && (typeof protectedOfficeSetControlHandler.matches !== "function"
        || typeof protectedOfficeSetControlHandler.handle !== "function")) {
    throw new TypeError("protected office-set control handler is invalid");
  }
  if (typeof nodeTransportIdentityResolver !== "function") throw new TypeError("managed node transport identity resolver is invalid");
  if (teamDriveApi !== null && (typeof teamDriveApi.matches !== "function" || typeof teamDriveApi.handle !== "function" || typeof teamDriveApi.bodyKind !== "function")) {
    throw new TypeError("Team Drive API is invalid");
  }
  if (objectApi !== null && (typeof objectApi.matches !== "function" || typeof objectApi.handle !== "function" || typeof objectApi.bodyKind !== "function")) {
    throw new TypeError("object API is invalid");
  }
  if (credentialAuthentication !== null && typeof credentialAuthentication.authenticate !== "function") {
    throw new TypeError("credential authentication service is invalid");
  }
  if (ownerSetupAuthority !== null && typeof ownerSetupAuthority.verify !== "function") {
    throw new TypeError("owner setup authority is invalid");
  }
  if (ownerRecoveryAuthority !== null
      && (typeof ownerRecoveryAuthority.createChallenge !== "function" || typeof ownerRecoveryAuthority.verify !== "function")) {
    throw new TypeError("owner recovery authority is invalid");
  }
  if (realtimeSpeechTransport !== null && (typeof realtimeSpeechTransport.transcribe !== "function"
      || !Number.isSafeInteger(realtimeSpeechTransport.maximumChunkBytes))) {
    throw new TypeError("realtime speech transport is invalid");
  }
  const allowedOrigin = safeOrigin(publicOrigin);
  const log = logger ?? createStructuredLogger({ service: "platform-api" });

  const server = createServer((request, response) => {
    const requestId = correlationIdFromRequest(request);
    const disconnect = new AbortController();
    response.once("close", () => disconnect.abort());
    void runWithCorrelation(requestId, async () => {
      const pathname = requestPath(request);
      try {
        // One-use media handles are memory-only. Plain HTTP attempts must not
        // send these paths into request/audit logging or generic proxies.
        if (pathname?.startsWith("/api/v1/casting/media/")) {
          jsonResponse(response, requestId, 404, { error: { code: "not_found" } });
          return;
        }
        if (!pathname) throw new PlatformError("invalid_request", "Request target is invalid", { status: 400 });
        if (request.method === "GET" && pathname === "/health/live") {
          jsonResponse(response, requestId, 200, { status: "live" });
          return;
        }
        if (request.method === "GET" && pathname === "/health/ready") {
          jsonResponse(response, requestId, 200, { status: "ready" });
          return;
        }
        if (protectedOfficeSetControlHandler?.matches(request.method, pathname)) {
          const body = await jsonBody(request, MAX_PROTECTED_OFFICE_CONTROL_BODY_BYTES);
          const result = await protectedOfficeSetControlHandler.handle({
            method: request.method,
            path: pathname,
            remoteAddress: request.socket.remoteAddress,
            headers: request.headers,
            body,
          });
          jsonResponse(response, requestId, 200, result);
          return;
        }
        if (request.method === "GET" && pathname === "/api/setup/status") {
          requireSecureTransport(request);
          const state = await authentication.bootstrapState();
          jsonResponse(response, requestId, 200, {
            ...state,
            claimProtected: state.required && ownerSetupAuthority !== null,
            ownerRecoveryAvailable: ownerRecoveryAuthority !== null,
          });
          return;
        }
        if (request.method === "POST" && pathname === "/api/setup/owner") {
          requireSecureTransport(request);
          requireSameOrigin(request, allowedOrigin);
          const body = await jsonBody(request);
          const state = await authentication.bootstrapState();
          if (!state.required) {
            throw new PlatformError("bootstrap_complete", "Appliance owner bootstrap is already complete", { status: 409 });
          }
          if (!ownerSetupAuthority) {
            throw new PlatformError("setup_unavailable", "Protected owner setup is not configured", { status: 503 });
          }
          if (!(await ownerSetupAuthority.verify(body.setupToken))) {
            throw new PlatformError("setup_denied", "Owner setup proof is invalid", { status: 401 });
          }
          const result = await authentication.bootstrapOwner({
            loginName: body.loginName,
            displayName: body.displayName,
            password: body.password,
          });
          jsonResponse(response, requestId, 201, result);
          return;
        }
        if (request.method === "POST" && pathname === "/api/auth/owner-recovery/challenge") {
          requireSecureTransport(request);
          requireSameOrigin(request, allowedOrigin);
          if (!ownerRecoveryAuthority) {
            throw new PlatformError("recovery_unavailable", "Protected owner recovery is not configured", { status: 503 });
          }
          try {
            const challenge = ownerRecoveryAuthority.createChallenge({ networkIdentifier: networkIdentifier(request) });
            jsonResponse(response, requestId, 201, challenge);
          } catch (error) {
            if (error instanceof OwnerRecoveryAuthorityError) {
              throw new PlatformError(error.code, error.message, { status: error.status, retryable: error.status === 429 });
            }
            throw error;
          }
          return;
        }
        if (request.method === "POST" && pathname === "/api/auth/owner-recovery") {
          requireSecureTransport(request);
          requireSameOrigin(request, allowedOrigin);
          if (!ownerRecoveryAuthority) {
            throw new PlatformError("recovery_unavailable", "Protected owner recovery is not configured", { status: 503 });
          }
          const body = await jsonBody(request);
          const result = await authentication.recoverOwner({
            recoveryCode: body.recoveryCode,
            newPassword: body.newPassword,
            localRecoveryChallenge: body.challenge,
            localRecoveryProof: body.localRecoveryProof,
          });
          jsonResponse(response, requestId, 200, result);
          return;
        }
        if (externalObjectProxyApi?.matches(request.method, pathname)) {
          requireSecureTransport(request);
          const kind = externalObjectProxyApi.bodyKind(request.method, pathname);
          const body = kind === "bytes" ? await byteBody(request) : null;
          const result = await externalObjectProxyApi.handle({
            method: request.method, pathname, body, headers: request.headers,
            requestId, signal: disconnect.signal,
          });
          if (result.kind === "bytes" || result.kind === "empty") nonJsonResponse(response, requestId, result);
          else jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (request.method === "GET" && pathname === "/api/auth/session") {
          requireSecureTransport(request);
          const context = await authenticatedContext(request, authentication);
          jsonResponse(response, requestId, 200, {
            authenticated: true,
            identity: context.identity,
            permissions: context.permissions,
            teamMemberships: context.teamMemberships,
            teamRoles: context.teamRoles,
            preferences: {
              preferredLocale: context.identity.preferredLocale,
              preferredLocaleExplicit: context.identity.preferredLocaleExplicit === true,
              preferredTheme: context.identity.preferredTheme,
            },
          });
          return;
        }
        if (request.method === "POST" && pathname === "/api/auth/sign-in") {
          requireSecureTransport(request);
          requireSameOrigin(request, allowedOrigin);
          const body = await jsonBody(request);
          const result = await authentication.signIn({
            loginName: body.loginName,
            password: body.password,
            networkIdentifier: networkIdentifier(request),
            userAgent: request.headers["user-agent"] || "",
          });
          response.setHeader("set-cookie", [
            sessionCookie(result.sessionToken, result.expiresAt),
            csrfCookie(result.csrfToken, result.expiresAt),
          ]);
          const context = await authentication.authenticateSession({ sessionToken: result.sessionToken });
          jsonResponse(response, requestId, 200, {
            authenticated: true,
            csrfToken: result.csrfToken,
            identity: result.identity,
            permissions: context.permissions,
            teamMemberships: context.teamMemberships,
            teamRoles: context.teamRoles,
            preferences: {
              preferredLocale: result.identity.preferredLocale,
              preferredLocaleExplicit: result.identity.preferredLocaleExplicit === true,
              preferredTheme: result.identity.preferredTheme,
            },
          });
          return;
        }
        if (request.method === "POST" && pathname === "/api/auth/sign-out") {
          requireSameOrigin(request, allowedOrigin);
          const context = await authenticatedContext(request, authentication, { csrf: true });
          try {
            await castingApi?.handleSignOut?.({ context });
          } catch (error) {
            log.warn("platform.cast_sign_out_stop_failed", { errorCode: error?.code ?? "cast_stop_failed" });
          }
          await authentication.signOut(sessionToken(request));
          try {
            await virtualPhoneApi?.handleSignOut?.({ context });
            await computerDesktopApi?.handleSignOut({ context });
          } catch (error) {
            log.warn("platform.phone_sign_out_revoke_failed", { errorCode: error?.code ?? "phone_runtime_unavailable" });
          }
          response.setHeader("set-cookie", [clearSessionCookie(), clearCsrfCookie()]);
          jsonResponse(response, requestId, 200, { signedOut: true });
          return;
        }
        if (request.method === "POST" && pathname === "/api/auth/recovery-codes/rotate") {
          requireSameOrigin(request, allowedOrigin);
          const context = await authenticatedContext(request, authentication, { csrf: true });
          const recoveryCodes = await authentication.rotateRecoveryCodes(context.identityId, context);
          jsonResponse(response, requestId, 200, { recoveryCodes });
          return;
        }
        if (request.method === "PATCH" && pathname === "/api/preferences/locale") {
          requireSameOrigin(request, allowedOrigin);
          const context = await authenticatedContext(request, authentication, { csrf: true });
          const body = await jsonBody(request);
          const result = await preferences.updatePreferredLocale({ context, locale: body.locale });
          jsonResponse(response, requestId, 200, result);
          return;
        }
        if (request.method === "PATCH" && pathname === "/api/preferences/theme") {
          requireSameOrigin(request, allowedOrigin);
          const context = await authenticatedContext(request, authentication, { csrf: true });
          const body = await jsonBody(request);
          const result = await preferences.updatePreferredTheme({ context, theme: body.theme });
          jsonResponse(response, requestId, 200, result);
          return;
        }
        if (request.method === "GET" && pathname === "/events/session") {
          const context = await authenticatedContext(request, authentication);
          applyApiHeaders(response, requestId);
          response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          });
          response.write(`id: 1\nevent: session.ready\ndata: ${JSON.stringify({ identityId: context.identity.id })}\n\n`);
          if (requestQuery(request).get("once") === "1") {
            response.end();
            return;
          }
          const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
          request.on("close", () => clearInterval(heartbeat));
          return;
        }
        if (applianceAgentApi?.matches(request.method, pathname)) {
          const routeKind = applianceAgentApi.routeKind(request.method, pathname);
          let context = null, transportIdentity = null;
          if (routeKind === "administrator") {
            context = await administrativeContext(request, { authentication, publicOrigin: allowedOrigin, stateChanging: request.method !== "GET" });
          } else if (routeKind === "managed-node") {
            transportIdentity = await nodeTransportIdentityResolver(request);
          } else {
            requireSecureTransport(request);
          }
          const body = request.method === "GET" ? null : await jsonBody(request, MAX_COMPUTE_BODY_BYTES,
            routeKind === 'managed-node' ? {account: nodeControlMemory} : {});
          const result = await applianceAgentApi.handle({ method: request.method, pathname, body, context, transportIdentity, requestId, signal: disconnect.signal });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (operationsApi?.matches(request.method, pathname)) {
          const stateChanging = request.method !== "GET";
          const context = await administrativeContext(request, { authentication, publicOrigin: allowedOrigin, stateChanging });
          const body = stateChanging ? await jsonBody(request, MAX_COMPUTE_BODY_BYTES) : null;
          const result = await operationsApi.handle({ method: request.method, pathname, context, body, query: requestQuery(request), requestId, signal: disconnect.signal });
          if (result.kind === "stream") {
            applyApiHeaders(response, requestId);
            response.writeHead(result.status, result.headers);
            await pipeline(Readable.from(result.body), response, { signal: disconnect.signal });
            return;
          }
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (queueAdministrationApi?.matches(request.method, pathname)) {
          const stateChanging = request.method !== "GET";
          const context = await administrativeContext(request, { authentication, publicOrigin: allowedOrigin, stateChanging });
          const body = stateChanging ? await jsonBody(request, MAX_COMPUTE_BODY_BYTES) : null;
          const result = await queueAdministrationApi.handle({ method: request.method, pathname, context, body, query: requestQuery(request), requestId, signal: disconnect.signal });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (storageAdministrationApi?.matches(request.method, pathname)) {
          const stateChanging = request.method !== "GET";
          const context = await administrativeContext(request, { authentication, publicOrigin: allowedOrigin, stateChanging });
          const body = stateChanging ? await jsonBody(request, MAX_COMPUTE_BODY_BYTES) : null;
          const result = await storageAdministrationApi.handle({ method: request.method, pathname, context, body, requestId, signal: disconnect.signal });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (encryptionAdministrationApi?.matches(request.method, pathname)) {
          const stateChanging = request.method !== "GET";
          const context = await administrativeContext(request, { authentication, publicOrigin: allowedOrigin, stateChanging });
          const body = stateChanging ? await jsonBody(request, MAX_COMPUTE_BODY_BYTES) : null;
          const result = await encryptionAdministrationApi.handle({ method: request.method, pathname, context, body, requestId, signal: disconnect.signal });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (auditApi?.matches(request.method, pathname)) {
          const context = await administrativeContext(request, { authentication, publicOrigin: allowedOrigin, stateChanging: false });
          const result = await auditApi.handle({ method: request.method, pathname, context, query: requestQuery(request), requestId, signal: disconnect.signal });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (pluginAdministrationApi?.matches(request.method, pathname)) {
          const stateChanging = request.method !== "GET";
          const context = await administrativeContext(request, { authentication, publicOrigin: allowedOrigin, stateChanging });
          const body = stateChanging ? await jsonBody(request, MAX_COMPUTE_BODY_BYTES) : null;
          const result = await pluginAdministrationApi.handle({ method: request.method, pathname, context, body, requestId, signal: disconnect.signal });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (pluginAccessApi?.matches(request.method, pathname)) {
          const routeKind = pluginAccessApi.routeKind(request.method, pathname);
          let context = null;
          if (routeKind === "user") {
            requireSameOrigin(request, allowedOrigin);
            context = await authenticatedContext(request, authentication, { csrf: true });
          } else requireSecureTransport(request);
          const body = request.method === "DELETE" ? null : await jsonBody(request, MAX_COMPUTE_BODY_BYTES);
          const result = await pluginAccessApi.handle({ method: request.method, pathname, context, body,
            headers: request.headers, requestId, signal: disconnect.signal });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (maintenanceApi?.matches(request.method, pathname)) {
          const stateChanging = request.method !== "GET";
          const context = await administrativeContext(request, { authentication, publicOrigin: allowedOrigin, stateChanging });
          const body = stateChanging ? await jsonBody(request, MAX_COMPUTE_BODY_BYTES) : null;
          const result = await maintenanceApi.handle({ method: request.method, pathname, context, body, requestId, signal: disconnect.signal });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (applicationCatalogApi?.matches(request.method, pathname)) {
          requireSecureTransport(request);
          const context = await authenticatedContext(request, authentication);
          const result = await applicationCatalogApi.handle({ method: request.method, pathname, target: request.url || pathname,
            context, requestId, signal: disconnect.signal });
          if (result.kind === "bytes" || result.kind === "empty") nonJsonResponse(response, requestId, result);
          else jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (identityDirectoryApi?.matches(request.method, pathname)) {
          requireSecureTransport(request);
          const context = await authenticatedContext(request, authentication);
          const result = await identityDirectoryApi.handle({
            method: request.method, pathname, context, query: requestQuery(request), requestId, signal: disconnect.signal,
          });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (identityAdministrationApi?.matches(request.method, pathname)) {
          const stateChanging = request.method !== "GET";
          const context = await administrativeContext(request, {
            authentication,
            publicOrigin: allowedOrigin,
            stateChanging,
          });
          const body = stateChanging ? await jsonBody(request) : null;
          const result = await identityAdministrationApi.handle({
            method: request.method,
            pathname,
            context,
            body,
            query: requestQuery(request),
            requestId,
            signal: disconnect.signal,
          });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (credentialApi?.matches(request.method, pathname)) {
          const stateChanging = request.method !== "GET";
          if (stateChanging) requireSameOrigin(request, allowedOrigin);
          const context = await authenticatedContext(request, authentication, { csrf: stateChanging });
          const body = stateChanging ? await jsonBody(request) : null;
          const result = await credentialApi.handle({
            method: request.method, pathname, context, body, query: requestQuery(request),
            requestId, signal: disconnect.signal,
          });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (messagingApi?.matches(request.method, pathname)) {
          const stateChanging = request.method !== "GET";
          const context = await administrativeContext(request, { authentication, publicOrigin: allowedOrigin, stateChanging });
          const body = stateChanging ? await jsonBody(request, MAX_COMPUTE_BODY_BYTES) : null;
          const result = await messagingApi.handle({
            method: request.method, pathname, body, context, headers: request.headers,
            query: requestQuery(request), requestId, signal: disconnect.signal,
          });
          if (result.kind === "sse") await sseResponse(request, response, requestId, result);
          else jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (virtualComputerApi?.matches(request.method, pathname)) {
          const stateChanging=request.method!=='GET';
          const context=await administrativeContext(request,{authentication,publicOrigin:allowedOrigin,stateChanging});
          const result=await virtualComputerApi.handle({method:request.method,pathname,context,
            body:stateChanging?await jsonBody(request,MAX_COMPUTE_BODY_BYTES):null,query:requestQuery(request),headers:request.headers});
          jsonResponse(response,requestId,result.status,result.body,result.headers);
          return;
        }
        if (computerDesktopApi?.matches(request.method, pathname)) {
          const stateChanging=request.method!=='GET';
          const context = await administrativeContext(request, { authentication, publicOrigin: allowedOrigin, stateChanging });
          const result = await computerDesktopApi.handle({ method: request.method, pathname, context,
            body: stateChanging?await jsonBody(request, 16 * 1024):null, query: requestQuery(request) });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (virtualPhoneApi?.matches(request.method, pathname)) {
          const stateChanging = request.method !== "GET";
          const context = await administrativeContext(request, { authentication, publicOrigin: allowedOrigin, stateChanging });
          const body = stateChanging ? await jsonBody(request, /\/camera\/browser\/offer$/.test(pathname)?73728:16 * 1024) : null;
          const result = await virtualPhoneApi.handle({ method: request.method, pathname, body, context,
            query: requestQuery(request), headers: request.headers, signal:disconnect.signal,clientAddress:networkIdentifier(request) });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (castingApi?.matches(request.method, pathname)) {
          const stateChanging = request.method !== "GET";
          const context = await administrativeContext(request, { authentication, publicOrigin: allowedOrigin, stateChanging });
          const body = stateChanging ? await jsonBody(request, MAX_COMPUTE_BODY_BYTES) : null;
          const result = await castingApi.handle({
            method: request.method, pathname, body, context, headers: request.headers,
            query: requestQuery(request), requestId, signal: disconnect.signal,
          });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (userActivityApi?.matches(request.method, pathname)) {
          const stateChanging = request.method !== "GET";
          const context = await administrativeContext(request, { authentication, publicOrigin: allowedOrigin, stateChanging });
          const result = await userActivityApi.handle({ method: request.method, pathname, context, requestId, signal: disconnect.signal });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (assistantApi?.matches(request.method, pathname)) {
          const context = await computeContext(request, {
            authentication,
            credentialAuthentication,
            publicOrigin: allowedOrigin,
            stateChanging: request.method !== "GET",
            operation: { method: request.method, pathname },
          });
          const body = request.method === "GET" ? null : await jsonBody(request, MAX_COMPUTE_BODY_BYTES);
          const result = await assistantApi.handle({
            method: request.method,
            pathname,
            body,
            context,
            headers: request.headers,
            query: requestQuery(request),
            requestId,
            signal: disconnect.signal,
          });
          if (result.kind === "sse") {
            await sseResponse(request, response, requestId, result);
          } else if (result.kind === "redirect") {
            applyApiHeaders(response, requestId);
            response.writeHead(result.status, result.headers);
            response.end();
          } else {
            jsonResponse(response, requestId, result.status, result.body, result.headers);
          }
          return;
        }
        if (modelLifecycleApi?.matches(request.method, pathname)) {
          const context = await administrativeContext(request, {
            authentication,
            publicOrigin: allowedOrigin,
            stateChanging: request.method !== "GET",
          });
          const body = request.method === "GET" ? null : await jsonBody(request, MAX_COMPUTE_BODY_BYTES);
          const result = await modelLifecycleApi.handle({
            method: request.method,
            pathname,
            body,
            context,
            headers: request.headers,
            query: requestQuery(request),
            requestId,
            signal: disconnect.signal,
          });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (sourceCenterApi?.matches(request.method, pathname)) {
          const context = await administrativeContext(request, {
            authentication,
            publicOrigin: allowedOrigin,
            stateChanging: request.method !== "GET",
          });
          const body = request.method === "GET" ? null : await jsonBody(request, MAX_COMPUTE_BODY_BYTES);
          const result = await sourceCenterApi.handle({ method: request.method, pathname, body, context, headers: request.headers, query: requestQuery(request), requestId, signal: disconnect.signal });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (offlineMediaApi?.matches(request.method, pathname)) {
          const context = await administrativeContext(request, {
            authentication,
            publicOrigin: allowedOrigin,
            stateChanging: request.method !== "GET",
          });
          const body = request.method === "GET" ? null : await jsonBody(request, MAX_COMPUTE_BODY_BYTES);
          const result = await offlineMediaApi.handle({ method: request.method, pathname, body, context, headers: request.headers, query: requestQuery(request), requestId, signal: disconnect.signal });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (providerApi?.matches(request.method, pathname)) {
          const context = await administrativeContext(request, {
            authentication,
            publicOrigin: allowedOrigin,
            stateChanging: request.method !== "GET",
          });
          const body = request.method === "GET" ? null : await jsonBody(request, MAX_COMPUTE_BODY_BYTES);
          const result = await providerApi.handle({ method: request.method, pathname, body, context, headers: request.headers, query: requestQuery(request), requestId, signal: disconnect.signal });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (routingPolicyApi?.matches(request.method, pathname)) {
          const context = await administrativeContext(request, {
            authentication,
            publicOrigin: allowedOrigin,
            stateChanging: request.method !== "GET",
          });
          const body = request.method === "GET" ? null : await jsonBody(request, MAX_COMPUTE_BODY_BYTES);
          const result = await routingPolicyApi.handle({ method: request.method, pathname, body, context, requestId, signal: disconnect.signal });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (teamDriveApi?.matches(request.method, pathname)) {
          const stateChanging = request.method !== "GET";
          const context = await administrativeContext(request, {
            authentication,
            publicOrigin: allowedOrigin,
            stateChanging,
          });
          const kind = teamDriveApi.bodyKind(request.method, pathname);
          const body = kind === "json" ? await jsonBody(request, MAX_COMPUTE_BODY_BYTES) : null;
          const result = await teamDriveApi.handle({
            method: request.method,
            pathname,
            body,
            context,
            headers: request.headers,
            query: requestQuery(request),
            requestId,
          });
          jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (objectApi?.matches(request.method, pathname)) {
          const stateChanging = request.method !== "GET" && request.method !== "HEAD";
          const context = await administrativeContext(request, {
            authentication,
            publicOrigin: allowedOrigin,
            stateChanging,
          });
          const kind = objectApi.bodyKind(request.method, pathname);
          const body = kind === "bytes"
            ? await byteBody(request)
            : kind === "json" ? await jsonBody(request, MAX_COMPUTE_BODY_BYTES) : null;
          const result = await objectApi.handle({
            method: request.method,
            pathname,
            body,
            context,
            headers: request.headers,
            query: requestQuery(request),
            requestId,
          });
          if (result.kind === "bytes" || result.kind === "empty") nonJsonResponse(response, requestId, result);
          else jsonResponse(response, requestId, result.status, result.body, result.headers);
          return;
        }
        if (matchesComputeHttpRoute(request.method, pathname)) {
          if (!computeApi) {
            throw new PlatformError("compute_unavailable", "Compute service is unavailable", {
              status: 503,
              retryable: true,
            });
          }
          const context = await computeContext(request, {
            authentication,
            credentialAuthentication,
            publicOrigin: allowedOrigin,
            stateChanging: request.method !== "GET",
            operation: { method: request.method, pathname },
          });
          const body = request.method === "GET" ? null : await jsonBody(request, MAX_COMPUTE_BODY_BYTES);
          const result = await computeApi.handle({
            method: request.method,
            pathname,
            body,
            context,
            headers: request.headers,
            requestId,
          });
          if (result.kind === "sse") {
            await sseResponse(request, response, requestId, result);
          } else {
            jsonResponse(response, requestId, result.status, result.body, result.headers);
          }
          return;
        }
        throw new PlatformError("not_found", "Endpoint was not found", { status: 404 });
      } catch (error) {
        const failure = pathname?.startsWith("/v1/")
          ? openAiErrorResponse(error, requestId)
          : errorResponse(error, requestId);
        log.warn("platform.request_failed", {
          method: request.method,
          path: pathname,
          status: failure.status,
          error,
        });
        if (!response.headersSent) jsonResponse(response, requestId, failure.status, failure.body);
        else response.destroy();
      }
    });
  });

  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      if (request.url?.startsWith('/api/v1/virtual-computers/')) {
        try {
          const authenticate = () => administrativeContext(request, { authentication, publicOrigin: allowedOrigin, stateChanging: false });
          const context = await authenticate();
          requireSameOrigin(request, allowedOrigin);
          if (computerDesktopApi && await computerDesktopApi.attachUpgrade(request, socket, head, { context, authenticate })) return;
        } catch { /* Never log desktop URLs: they contain short-lived handshake tokens. */ }
        rejectUpgrade(socket, 403, 'Forbidden'); return;
      }
      if (request.url?.startsWith("/api/v1/virtual-phones/")) {
        try {
          // Debug CLI presents the once-only Web-issued ticket in its first
          // frame. The gateway resolves and rechecks the originating login.
          const {matchesPhoneAdbUpgrade}=await import("../src/virtual-phones/phone-adb-gateway.mjs");
          if(matchesPhoneAdbUpgrade(request.url)) {
            requireSecureTransport(request);
            if(virtualPhoneMediaGateway && await virtualPhoneMediaGateway.attachUpgrade(request,socket,head))return;
            rejectUpgrade(socket,403,"Forbidden");return;
          }
          const context=await administrativeContext(request,{authentication,publicOrigin:allowedOrigin,stateChanging:false});
          requireSameOrigin(request,allowedOrigin);
          if (virtualPhoneMediaGateway && await virtualPhoneMediaGateway.attachUpgrade(request,socket,head,{context}))return;
        } catch { /* Phone signalling credentials and upstream details are never logged. */ }
        rejectUpgrade(socket,403,"Forbidden");return;
      }
      // The media gateway owns its errors and never logs credential-bearing
      // paths. Unrelated session/speech upgrades retain their existing handler.
      if (request.url?.startsWith("/api/v1/casting/media/")) {
        try {
          if (castingMediaGateway && await castingMediaGateway.attachUpgrade(request, socket, head)) return;
        } catch { /* fail closed without private transport detail */ }
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }
      const pathname = requestPath(request);
      let cleanupRealtime = null;
      let speechSession = null;
      try {
        const realtime = matchesComputeRealtimeRoute(pathname);
        if (pathname !== "/ws/session" && !realtime) {
          throw new PlatformError("not_found", "Endpoint was not found", { status: 404 });
        }
        requireSecureTransport(request);
        requireSameOrigin(request, allowedOrigin);
        const context = await authenticatedContext(request, authentication);
        const accept = websocketAccept(String(request.headers["sec-websocket-key"] || ""));
        if (request.headers.upgrade?.toLowerCase() !== "websocket" || request.headers["sec-websocket-version"] !== "13" || !accept) {
          throw new PlatformError("invalid_websocket", "WebSocket handshake is invalid", { status: 400 });
        }
        if (realtime && !computeApi) {
          throw new PlatformError("compute_unavailable", "Compute service is unavailable", {
            status: 503,
            retryable: true,
          });
        }
        const connectionId = randomUUID();
        const computeContextValue = { identityId: context.identity.id };
        const connected = realtime
          ? await computeApi.connectRealtimeSession({
            pathname,
            context: computeContextValue,
            connectionId,
            now: new Date(),
          })
          : null;
        if (realtime && connected.capability === "asr" && !realtimeSpeechTransport) {
          throw new PlatformError("realtime_speech_unavailable", "Realtime speech transport is not configured", {
            status: 503,
            retryable: true,
          });
        }
        let cleaned = false;
        let heartbeat = null;
        let expiry = null;
        cleanupRealtime = async (reason = "websocket_disconnect") => {
          if (!realtime || cleaned) return;
          cleaned = true;
          if (heartbeat) clearInterval(heartbeat);
          if (expiry) clearTimeout(expiry);
          try {
            await computeApi.disconnectRealtimeSession({
              sessionId: connected.sessionId,
              context: computeContextValue,
              connectionId,
              reason,
              now: new Date(),
            });
          } catch (error) {
            log.warn("platform.realtime_disconnect_cleanup_failed", {
              sessionId: connected.sessionId,
              error,
            });
          }
        };
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\n"
          + "Upgrade: websocket\r\n"
          + "Connection: Upgrade\r\n"
          + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        const ready = realtime ? {
          protocolVersion: 1,
          sessionId: connected.sessionId,
          eventId: randomUUID(),
          sequence: 0,
          type: "realtime.session.ready",
          occurredAt: new Date().toISOString(),
          required: true,
          payload: {
            capability: connected.capability,
            model: connected.model,
            expiresAt: connected.expiresAt,
          },
        } : { type: "session.ready", identityId: context.identity.id };
        socket.write(websocketTextFrame(JSON.stringify(ready)));
        heartbeat = setInterval(() => {
          if (!realtime) {
            socket.write(Buffer.from([0x89, 0x00]));
            return;
          }
          void computeApi.heartbeatRealtimeSession({
            sessionId: connected.sessionId,
            context: computeContextValue,
            connectionId,
            now: new Date(),
          }).then(() => socket.write(Buffer.from([0x89, 0x00]))).catch(() => {
            socket.destroy();
            void cleanupRealtime("heartbeat_failed");
          });
        }, realtime ? 10_000 : 20_000);
        heartbeat.unref();
        if (realtime) {
          const expiresIn = Math.max(1, new Date(connected.expiresAt).getTime() - Date.now());
          expiry = setTimeout(() => {
            socket.destroy();
            void cleanupRealtime("session_expired");
          }, expiresIn);
          expiry.unref();
        }
        const cleanup = (reason) => {
          speechSession?.stop();
          clearInterval(heartbeat);
          if (expiry) clearTimeout(expiry);
          void cleanupRealtime?.(reason);
        };
        socket.on("close", () => cleanup("websocket_disconnect"));
        socket.on("error", () => cleanup("websocket_error"));
        socket.on("end", () => cleanup("websocket_disconnect"));
        if (realtime && connected.capability === "asr") {
          speechSession = new RealtimeWebSocketSpeechSession({
            socket,
            connected,
            transport: realtimeSpeechTransport,
            onFatal(error) {
              log.warn("platform.realtime_speech_failed", { sessionId: connected.sessionId, error });
              void cleanupRealtime("realtime_worker_failed");
            },
          });
          speechSession.start(head);
        } else if (head?.byteLength) {
          socket.unshift(head);
        }
      } catch (error) {
        await cleanupRealtime?.("websocket_handshake_failed");
        const status = error instanceof PlatformError ? error.status : 500;
        rejectUpgrade(socket, status, status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Bad Request");
      }
    })();
  });

  server.once("close",()=>{void virtualPhoneMediaGateway?.close();});
  server.once('close', () => computerDesktopApi?.close());
  return server;
}

async function loadBootstrap(path) {
  if (!path?.startsWith("/")) throw new TypeError("PLATFORM_API_BOOTSTRAP_FILE must be an absolute path");
  const raw = await readFile(path);
  try {
    const value = JSON.parse(raw.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value;
  } finally {
    raw.fill(0);
  }
}

async function loadApiCredentialPepper(path) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new TypeError("PLATFORM_API_CREDENTIAL_PEPPER_FILE must be an absolute path");
  }
  const raw = await readFile(path);
  try {
    const encoded = raw.toString("utf8").trim();
    if (!/^[A-Za-z0-9_-]{43,171}$/.test(encoded)) throw new TypeError("API credential pepper file is invalid");
    const value = Buffer.from(encoded, "base64url");
    if (value.byteLength < 32 || value.byteLength > 128 || value.toString("base64url") !== encoded) {
      value.fill(0);
      throw new TypeError("API credential pepper file is invalid");
    }
    return value;
  } finally {
    raw.fill(0);
  }
}

export async function startPlatformApi(environment = process.env, dependencies = {}) {
  const host = environment.PLATFORM_API_HOST || "0.0.0.0";
  const port = Number(environment.PLATFORM_API_PORT || "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new TypeError("PLATFORM_API_PORT is invalid");
  const publicOrigin = safeOrigin(environment.PLATFORM_API_PUBLIC_ORIGIN || "");
  // Validate the protected trusted-media configuration before allocating any
  // owned services. A partial certificate/endpoint set must fail atomically.
  const trustedMediaRuntimeEnabled = trustedMediaRuntimeConfigured(environment);
  const castingSignallingEnabled = castingMediaSignallingConfigured(environment);
  const castingCallbackEnabled = castingCallbackConfigured(environment);
  const castingActivation = environment.PLATFORM_CASTING_ACTIVATION_MODE;
  if (castingActivation && castingActivation !== "development") throw new TypeError("Unsupported casting activation mode");
  const castingFailurePolicy = environment.PLATFORM_CASTING_FAILURE_POLICY;
  if (castingFailurePolicy && castingFailurePolicy !== "isolate") throw new TypeError("Unsupported casting failure policy");
  if (castingCallbackEnabled && !trustedMediaRuntimeEnabled && !dependencies.castingRuntime) {
    throw new TypeError("Casting callbacks require the private media runtime");
  }
  if (castingActivation && (!castingCallbackEnabled || !trustedMediaRuntimeEnabled || !castingSignallingEnabled
    || !environment.PLATFORM_CASTING_RUNTIME_IDENTITY_FILE || environment.PLATFORM_CASTING_AVAILABILITY_FILE
    || !dependencies.database)) {
    throw new TypeError("Casting development activation requires the complete durable private runtime configuration");
  }
  if (castingSignallingEnabled && !trustedMediaRuntimeEnabled && !dependencies.castingRuntime) {
    throw new TypeError("Authenticated casting signalling requires the private media runtime");
  }
  const agentCredentialConfigured = Boolean(environment.PLATFORM_AGENT_MODEL_SIGNING_KEY_FILE)
    || Boolean(environment.PLATFORM_AGENT_MODEL_ALIAS_MAP_FILE);
  if (agentCredentialConfigured && (!environment.PLATFORM_AGENT_MODEL_SIGNING_KEY_FILE
      || !environment.PLATFORM_AGENT_MODEL_ALIAS_MAP_FILE)) {
    throw new TypeError("Agent model signing key and alias map files must be configured together");
  }
  let ownedAgentCredentialAuthority = null;
  let credentialAuthentication = dependencies.credentialAuthentication ?? null;
  if (!credentialAuthentication && agentCredentialConfigured) {
    const signingKey = await loadAgentModelSigningKey(environment.PLATFORM_AGENT_MODEL_SIGNING_KEY_FILE);
    try {
      ownedAgentCredentialAuthority = new AgentModelCredentialAuthority({ signingKey });
    } finally {
      signingKey.fill(0);
    }
    try {
      credentialAuthentication = new AgentComputeCredentialAuthentication({
        authority: ownedAgentCredentialAuthority,
        modelAliasMap: await loadAgentModelAliasMap(environment.PLATFORM_AGENT_MODEL_ALIAS_MAP_FILE),
      });
    } catch (error) {
      ownedAgentCredentialAuthority.close();
      throw error;
    }
  }
  const objectRpcConfigured = Boolean(environment.PLATFORM_OBJECT_SERVICE_ENDPOINT)
    || Boolean(environment.PLATFORM_OBJECT_SERVICE_TOKEN_FILE);
  if (!dependencies.objectService && objectRpcConfigured) {
    if (!environment.PLATFORM_OBJECT_SERVICE_ENDPOINT || !environment.PLATFORM_OBJECT_SERVICE_TOKEN_FILE) {
      throw new TypeError("object service endpoint and token file must be configured together");
    }
    const objectService = await RemoteProtectedObjectService.fromEnvironment(environment);
    dependencies = {
      ...dependencies,
      objectService,
      messagingAttachmentVerifier: dependencies.messagingAttachmentVerifier
        ?? objectService.createMessagingAttachmentVerifier(),
    };
  }
  const repository = dependencies.identityRepository ?? (dependencies.database
    ? new PostgresIdentityRepository({ database: dependencies.database })
    : new MemoryIdentityRepository());
  const logger = createStructuredLogger({ service: "platform-api" });
  if (dependencies.database && !dependencies.auditService && !dependencies.auditSigner && !dependencies.auditSigningKey) {
    throw new TypeError("Persistent platform audit requires a protected audit signer");
  }
  const ownsAuditSigner = !dependencies.auditService && !dependencies.auditSigner;
  const auditSigner = dependencies.auditService ? null : (dependencies.auditSigner ?? new HmacAuditSigner({ key: dependencies.auditSigningKey ?? randomBytes(32), keyId: dependencies.auditSigningKeyId ?? "audit.primary.v1" }));
  const auditService = dependencies.auditService ?? new TamperEvidentAuditService({
    repository: dependencies.auditRepository ?? (dependencies.database ? new PostgresAuditRepository({ database: dependencies.database }) : new MemoryAuditRepository()),
    signer: auditSigner,
  });
  const audit = async (event) => {
    const stored = await auditService.record(event);
    logger.info("platform.audit", { eventId: stored.eventId, sequenceId: stored.sequenceId, action: stored.action, domain: stored.domain,
      outcome: stored.outcome, resourceKind: stored.resource.kind, eventHash: stored.eventHash });
    return stored;
  };
  let ownedPluginRuntime = null;
  if (!dependencies.pluginAdministrationService && dependencies.pluginRuntimeFactory) {
    const runtime = await dependencies.pluginRuntimeFactory(environment, { database: dependencies.database, audit });
    if (!runtime?.service || typeof runtime.service.overview !== "function") throw new TypeError("plugin runtime is incomplete");
    ownedPluginRuntime = runtime;
    dependencies = { ...dependencies, pluginAdministrationService: runtime.service,
      ...(runtime.applicationRouteSource ? { pluginApplicationRouteSource: runtime.applicationRouteSource } : {}),
      ...(runtime.delegatedUserTokenService ? { pluginDelegatedUserTokenService: runtime.delegatedUserTokenService } : {}),
      ...(runtime.computeCapabilityRegistrationService ? { pluginComputeCapabilityRegistrationService: runtime.computeCapabilityRegistrationService } : {}),
      ...(runtime.schedulerAuthority ? { pluginSchedulerAuthority: runtime.schedulerAuthority } : {}) };
  }
  let ownedEncryptionTransitionRuntime = null;
  if (!dependencies.unlockProtectionTransitionService && dependencies.encryptionTransitionRuntimeFactory) {
    const runtime = await dependencies.encryptionTransitionRuntimeFactory(environment, { database: dependencies.database, audit });
    if (!runtime?.transitionService || !runtime?.statusSource) throw new TypeError("encryption transition runtime is incomplete");
    ownedEncryptionTransitionRuntime = runtime;
    dependencies = { ...dependencies, unlockProtectionTransitionService: runtime.transitionService,
      encryptionRuntimeStatusSource: runtime.statusSource };
  }
  const ownsOwnerRecoveryAuthority = !dependencies.ownerRecoveryAuthority
    && Boolean(environment.PLATFORM_OWNER_RECOVERY_KEY_FILE);
  const ownerRecoveryAuthority = dependencies.ownerRecoveryAuthority ?? (ownsOwnerRecoveryAuthority
    ? await OwnerRecoveryProofAuthority.fromFile(environment.PLATFORM_OWNER_RECOVERY_KEY_FILE)
    : null);
  const authentication = await LocalAuthentication.create({
    repository,
    audit,
    ...(ownerRecoveryAuthority ? { recoveryAuthority: ownerRecoveryAuthority } : {}),
  });
  let apiCredentialService = dependencies.apiCredentialService ?? null;
  if (!apiCredentialService && environment.PLATFORM_API_CREDENTIAL_PEPPER_FILE) {
    const pepper = await loadApiCredentialPepper(environment.PLATFORM_API_CREDENTIAL_PEPPER_FILE);
    try {
      apiCredentialService = new ApiCredentialService({
        repository: dependencies.credentialRepository ?? (dependencies.database
          ? new PostgresCredentialRepository({ database: dependencies.database })
          : new MemoryCredentialRepository()),
        credentialPepper: pepper,
        audit,
      });
    } finally {
      pepper.fill(0);
    }
  }
  if (apiCredentialService) {
    credentialAuthentication = credentialAuthentication
      ? new RoutedCredentialAuthentication({ agent: credentialAuthentication, api: apiCredentialService })
      : apiCredentialService;
  }
  let bootstrapState = typeof repository.bootstrapState === "function"
    ? await repository.bootstrapState()
    : { complete: false, ownerIdentityId: null };
  if (bootstrapState.complete) {
    logger.info("identity.bootstrap_present", { outcome: "resume_existing_owner" });
  } else {
    const bootstrapPath = environment.PLATFORM_API_BOOTSTRAP_FILE || "";
    if (bootstrapPath) {
      const bootstrap = await loadBootstrap(bootstrapPath);
      try {
        const result = await authentication.bootstrapOwner({
          loginName: bootstrap.loginName,
          displayName: bootstrap.displayName,
          password: bootstrap.password,
        });
        result.recoveryCodes.fill("[REDACTED]");
      } catch (error) {
        if (!(error instanceof PlatformError) || error.code !== "bootstrap_complete") throw error;
        logger.info("identity.bootstrap_present", { outcome: "concurrent_owner_bootstrap" });
      } finally {
        bootstrap.password = "[REDACTED]";
      }
      bootstrapState = typeof repository.bootstrapState === "function"
        ? await repository.bootstrapState()
        : { complete: true, ownerIdentityId: null };
    } else {
      logger.info("identity.setup_required", { outcome: "await_https_owner_setup" });
    }
  }
  const ownsOwnerSetupAuthority = !dependencies.ownerSetupAuthority
    && Boolean(environment.PLATFORM_API_SETUP_TOKEN_FILE)
    && !bootstrapState.complete;
  const ownerSetupAuthority = dependencies.ownerSetupAuthority ?? (ownsOwnerSetupAuthority
    ? await OwnerSetupTokenAuthority.fromFile(environment.PLATFORM_API_SETUP_TOKEN_FILE)
    : null);
  const preferences = new IdentityPreferencesService({ repository, audit });
  const artifactProvenance = dependencies.artifactProvenanceService ?? (
    dependencies.objectService?.createObjectHandoffGateway
      ? new ArtifactProvenanceService({
        repository: dependencies.artifactProvenanceRepository ?? (
          dependencies.database
            ? new PostgresArtifactProvenanceRepository({ database: dependencies.database })
            : new MemoryArtifactProvenanceRepository()
        ),
        objectGateway: dependencies.objectService.createObjectHandoffGateway(),
        audit,
      })
      : null
  );
  const unavailableRunner = Object.freeze({
    async run() {
      throw new PlatformError("assistant_compute_unavailable", "No certified Assistant execution route is active", {
        status: 503,
        retryable: true,
      });
    },
  });
  const localWorkerConfigured = Boolean(environment.LOCAL_OPENAI_WORKER_ORIGIN
    || environment.LOCAL_OPENAI_MODEL_ALIAS || environment.LOCAL_OPENAI_SERVED_MODEL);
  if (localWorkerConfigured && (!environment.LOCAL_OPENAI_WORKER_ORIGIN
    || !environment.LOCAL_OPENAI_MODEL_ALIAS || !environment.LOCAL_OPENAI_SERVED_MODEL)) {
    throw new TypeError("Local OpenAI worker origin, model alias, and served model must be configured together");
  }
  if (localWorkerConfigured && (!dependencies.database || !dependencies.objectService)) {
    throw new TypeError("Local queued compute requires PostgreSQL and protected object storage");
  }
  const drawingConfigurationKeys = [
    "DRAWING_WORKER_ORIGIN", "DRAWING_MODEL_ALIAS", "DRAWING_SERVED_MODEL", "DRAWING_PROFILE_ID",
    "DRAWING_PROFILE_KEY", "DRAWING_PROFILE_FINGERPRINT", "DRAWING_ENGINE_IMAGE_DIGEST",
  ];
  const drawingWorkerConfigured = drawingConfigurationKeys.some((key) => Boolean(environment[key]));
  if (drawingWorkerConfigured && drawingConfigurationKeys.some((key) => !environment[key])) {
    throw new TypeError("Drawing worker route, model, profile, and immutable evidence must be configured together");
  }
  if (drawingWorkerConfigured && !localWorkerConfigured) {
    throw new TypeError("Drawing execution currently requires the local durable compute service");
  }
  let drawingWorkerToken = null;
  if (drawingWorkerConfigured && environment.DRAWING_WORKER_TOKEN_FILE) {
    if (!environment.DRAWING_WORKER_TOKEN_FILE.startsWith("/")) {
      throw new TypeError("DRAWING_WORKER_TOKEN_FILE must be an absolute path");
    }
    const tokenBytes = await readFile(environment.DRAWING_WORKER_TOKEN_FILE);
    drawingWorkerToken = Buffer.from(tokenBytes.toString("utf8").trim(), "utf8");
    tokenBytes.fill(0);
    if (drawingWorkerToken.byteLength < 8 || drawingWorkerToken.byteLength > 8_192) {
      drawingWorkerToken.fill(0);
      throw new TypeError("Drawing worker protected credential is invalid");
    }
  }
  const ocrConfigurationKeys = [
    "OCR_WORKER_ORIGIN", "OCR_MODEL_ALIAS", "OCR_SERVED_MODEL", "OCR_PROFILE_ID",
    "OCR_PROFILE_KEY", "OCR_PROFILE_FINGERPRINT", "OCR_ENGINE_IMAGE_DIGEST",
  ];
  const ocrWorkerConfigured = ocrConfigurationKeys.some((key) => Boolean(environment[key]));
  if (ocrWorkerConfigured && ocrConfigurationKeys.some((key) => !environment[key])) {
    throw new TypeError("OCR worker route, model, profile, and immutable evidence must be configured together");
  }
  if (ocrWorkerConfigured && !localWorkerConfigured) {
    throw new TypeError("OCR execution currently requires the local durable compute service");
  }
  const asrConfigurationKeys = [
    "ASR_WORKER_ORIGIN", "ASR_MODEL_ALIAS", "ASR_SERVED_MODEL", "ASR_PROFILE_ID",
    "ASR_PROFILE_KEY", "ASR_PROFILE_FINGERPRINT", "ASR_ENGINE_IMAGE_DIGEST",
  ];
  const asrWorkerConfigured = asrConfigurationKeys.some((key) => Boolean(environment[key]));
  if (asrWorkerConfigured && asrConfigurationKeys.some((key) => !environment[key])) {
    throw new TypeError("ASR worker route, model, profile, and immutable evidence must be configured together");
  }
  if (asrWorkerConfigured && !localWorkerConfigured) {
    throw new TypeError("ASR execution currently requires the local durable compute service");
  }
  const translationConfigurationKeys = [
    "TRANSLATION_WORKER_ORIGIN", "TRANSLATION_MODEL_ALIAS", "TRANSLATION_SERVED_MODEL", "TRANSLATION_PROFILE_ID",
    "TRANSLATION_PROFILE_KEY", "TRANSLATION_PROFILE_FINGERPRINT", "TRANSLATION_ENGINE_IMAGE_DIGEST",
  ];
  const translationWorkerConfigured = translationConfigurationKeys.some((key) => Boolean(environment[key]));
  if (translationWorkerConfigured && translationConfigurationKeys.some((key) => !environment[key])) {
    throw new TypeError("Translation worker route, model, profile, and immutable evidence must be configured together");
  }
  if (translationWorkerConfigured && !localWorkerConfigured) {
    throw new TypeError("Translation execution currently requires the local durable compute service");
  }
  const embeddingConfigurationKeys = [
    "EMBEDDING_WORKER_ORIGIN", "EMBEDDING_MODEL_ALIAS", "EMBEDDING_SERVED_MODEL", "EMBEDDING_PROFILE_ID",
    "EMBEDDING_PROFILE_KEY", "EMBEDDING_PROFILE_FINGERPRINT", "EMBEDDING_ENGINE_IMAGE_DIGEST",
  ];
  const embeddingWorkerConfigured = embeddingConfigurationKeys.some((key) => Boolean(environment[key]));
  if (embeddingWorkerConfigured && embeddingConfigurationKeys.some((key) => !environment[key])) {
    throw new TypeError("Embedding worker route, model, profile, and immutable evidence must be configured together");
  }
  if (embeddingWorkerConfigured && !localWorkerConfigured) {
    throw new TypeError("Embedding execution currently requires the local durable compute service");
  }
  let embeddingTransportSecurity = null;
  if (embeddingWorkerConfigured) {
    const caFile = environment.EMBEDDING_WORKER_CA_FILE || null;
    const tokenFile = environment.EMBEDDING_WORKER_TOKEN_FILE || null;
    if (Boolean(caFile) !== Boolean(tokenFile)) {
      throw new TypeError("Embedding worker CA and token files must be configured together");
    }
    if (caFile) {
      if (!caFile.startsWith("/") || !tokenFile.startsWith("/")) {
        throw new TypeError("Embedding worker CA and token files must be absolute paths");
      }
      const [customCa, tokenBytes] = await Promise.all([
        readFile(caFile),
        readFile(tokenFile),
      ]);
      const credential = Buffer.from(tokenBytes.toString("utf8").trim(), "utf8");
      tokenBytes.fill(0);
      if (customCa.byteLength < 1 || customCa.byteLength > 1024 * 1024 || credential.byteLength < 8 || credential.byteLength > 8_192) {
        customCa.fill(0); credential.fill(0);
        throw new TypeError("Embedding worker protected transport material is invalid");
      }
      embeddingTransportSecurity = { customCa, credential, serverName: environment.EMBEDDING_WORKER_SERVER_NAME || null };
    }
  }
  const protectedLocalAttemptConfigured = Boolean(environment.PLATFORM_PROTECTED_OFFICE_SET_ID);
  if (protectedLocalAttemptConfigured) {
    const required = [
      "PLATFORM_PROTECTED_OFFICE_SET_NODE_ID", "LOCAL_OPENAI_WORKER_ID", "LOCAL_OPENAI_PROFILE_ID",
      ...(drawingWorkerConfigured ? ["DRAWING_WORKER_ID"] : []),
      ...(ocrWorkerConfigured ? ["OCR_WORKER_ID"] : []),
      ...(asrWorkerConfigured ? ["ASR_WORKER_ID"] : []),
      ...(translationWorkerConfigured ? ["TRANSLATION_WORKER_ID"] : []),
      ...(embeddingWorkerConfigured ? ["EMBEDDING_WORKER_ID"] : []),
    ];
    if (!localWorkerConfigured || !dependencies.database || required.some((key) => !environment[key])) {
      throw new TypeError("Protected local attempts require the exact set, node, Worker, and model profile identities");
    }
  }
  const durableJobsConfigured = localWorkerConfigured;
  const queueAdministrationRepository = dependencies.queueAdministrationRepository ?? (dependencies.database
    ? new PostgresQueueAdministrationRepository({ database: dependencies.database }) : null);
  const durableJobRepository = dependencies.durableJobRepository ?? (dependencies.database
    ? new PostgresDurableJobRepository({ database: dependencies.database }) : null);
  const durableJobService = dependencies.durableJobService ?? (durableJobsConfigured
    ? new DurableJobService({
      repository: durableJobRepository,
      payloadStore: new ObjectJobPayloadStore({ objectService: dependencies.objectService }),
      resolveCapability: async (capabilityKey) => {
        const result = await dependencies.database.query(`
          SELECT id, lifecycle_state, api_operations
          FROM compute.capabilities
          WHERE capability_key=$1`, [capabilityKey]);
        const row = result?.rows?.[0];
        return row ? {
          capabilityId: row.id,
          enabled: row.lifecycle_state === "active",
          operations: typeof row.api_operations === "string" ? JSON.parse(row.api_operations) : row.api_operations,
        } : null;
      },
      audit,
      policySource: queueAdministrationRepository,
      ...(artifactProvenance ? { artifactHandoff: new ComputeArtifactHandoff({ provenanceService: artifactProvenance }) } : {}),
    })
    : null);
  const externalProviderRepository = dependencies.externalProviderRepository ?? (dependencies.database
    ? new PostgresExternalProviderRepository({ database: dependencies.database })
    : new MemoryExternalProviderRepository());
  const routingPolicyRegistry = dependencies.routingPolicyRegistry ?? new RoutingPolicyRegistry({
    repository: dependencies.routingPolicyRepository ?? (dependencies.database
      ? new PostgresRoutingPolicyRepository({ database: dependencies.database })
      : new MemoryRoutingPolicyRepository()),
    audit,
  });
  const externalProviderExecutionRouter = dependencies.externalProviderExecutionRouter ?? (
    dependencies.database && dependencies.secretStore
      ? new ExternalProviderExecutionRouter({
        database: dependencies.database,
        providerRepository: externalProviderRepository,
        routingPolicyRegistry,
        secretStore: dependencies.secretStore,
        audit,
        modelRoutingPolicyKey: environment.PLATFORM_MODEL_ROUTING_POLICY_KEY ?? "production.default",
        modelRoutingEnvironment: environment.PLATFORM_MODEL_ROUTING_ENVIRONMENT ?? "production",
      })
      : null
  );
  const ownsExternalProviderExecutionRouter = !dependencies.externalProviderExecutionRouter
    && externalProviderExecutionRouter !== null;
  const externalAttemptRepository = dependencies.externalAttemptRepository ?? (
    dependencies.database && externalProviderExecutionRouter
      ? new PostgresExternalAttemptRepository({ database: dependencies.database })
      : null
  );
  const protectedLocalAttemptRepository = dependencies.protectedLocalAttemptRepository ?? (
    protectedLocalAttemptConfigured
      ? new PostgresProtectedLocalAttemptRepository({
        database: dependencies.database,
        setId: environment.PLATFORM_PROTECTED_OFFICE_SET_ID,
        nodeId: environment.PLATFORM_PROTECTED_OFFICE_SET_NODE_ID,
      })
      : null
  );
  const queueAdministrationService = dependencies.queueAdministrationService ?? (
    queueAdministrationRepository && durableJobRepository
      ? new QueueAdministrationService({ repository: queueAdministrationRepository, jobRepository: durableJobRepository, audit })
      : null
  );
  const unlockTransitionRepository = dependencies.unlockTransitionRepository ?? (dependencies.database
    ? new PostgresEncryptionAdministrationRepository({ database: dependencies.database }) : null);
  const unlockProtectionTransitionService = dependencies.unlockProtectionTransitionService ?? null;
  const encryptionAdministrationService = dependencies.encryptionAdministrationService ?? (unlockTransitionRepository
    ? new EncryptionAdministrationService({
      repository: unlockTransitionRepository,
      transitionService: unlockProtectionTransitionService,
      runtimeStatusSource: dependencies.encryptionRuntimeStatusSource ?? new EnvironmentEncryptionRuntimeStatusSource({
        environment,
        transitionAvailable: unlockProtectionTransitionService !== null,
      }),
    })
    : null);
  let localExecutionBridge = null;
  try {
    localExecutionBridge = localWorkerConfigured ? new OpenAiWorkerExecutionBridge({
      jobService: durableJobService,
      workerOrigin: environment.LOCAL_OPENAI_WORKER_ORIGIN,
      modelAlias: environment.LOCAL_OPENAI_MODEL_ALIAS,
      servedModel: environment.LOCAL_OPENAI_SERVED_MODEL,
      externalProviderRouter: externalProviderExecutionRouter,
      externalAttemptRepository,
      localAttemptRepository: protectedLocalAttemptRepository,
      workerId: environment.LOCAL_OPENAI_WORKER_ID || null,
      profileId: environment.LOCAL_OPENAI_PROFILE_ID || null,
    ...(drawingWorkerConfigured ? {
      drawingWorker: {
        workerOrigin: environment.DRAWING_WORKER_ORIGIN,
        modelAlias: environment.DRAWING_MODEL_ALIAS,
        servedModel: environment.DRAWING_SERVED_MODEL,
        profileId: environment.DRAWING_PROFILE_ID,
        profileKey: environment.DRAWING_PROFILE_KEY,
        profileFingerprint: environment.DRAWING_PROFILE_FINGERPRINT,
        engineImageDigest: environment.DRAWING_ENGINE_IMAGE_DIGEST,
        workerId: environment.DRAWING_WORKER_ID || undefined,
        acceptedModelAliases: (environment.DRAWING_MODEL_ALIASES || environment.DRAWING_MODEL_ALIAS)
          .split(",").map((value) => value.trim()).filter(Boolean),
        ...(drawingWorkerToken ? { bearerToken: drawingWorkerToken } : {}),
      },
    } : {}),
    ...(ocrWorkerConfigured ? {
      ocrWorker: {
        workerOrigin: environment.OCR_WORKER_ORIGIN,
        modelAlias: environment.OCR_MODEL_ALIAS,
        servedModel: environment.OCR_SERVED_MODEL,
        protocol: environment.OCR_WORKER_PROTOCOL || "layout-parsing-v1",
        profileId: environment.OCR_PROFILE_ID,
        profileKey: environment.OCR_PROFILE_KEY,
        profileFingerprint: environment.OCR_PROFILE_FINGERPRINT,
        engineImageDigest: environment.OCR_ENGINE_IMAGE_DIGEST,
        workerId: environment.OCR_WORKER_ID || undefined,
      },
    } : {}),
    ...(asrWorkerConfigured ? {
      asrWorker: {
        workerOrigin: environment.ASR_WORKER_ORIGIN,
        modelAlias: environment.ASR_MODEL_ALIAS,
        servedModel: environment.ASR_SERVED_MODEL,
        profileId: environment.ASR_PROFILE_ID,
        profileKey: environment.ASR_PROFILE_KEY,
        profileFingerprint: environment.ASR_PROFILE_FINGERPRINT,
        engineImageDigest: environment.ASR_ENGINE_IMAGE_DIGEST,
        workerId: environment.ASR_WORKER_ID || undefined,
      },
    } : {}),
    ...(translationWorkerConfigured ? {
      translationWorker: {
        workerOrigin: environment.TRANSLATION_WORKER_ORIGIN,
        modelAlias: environment.TRANSLATION_MODEL_ALIAS,
        servedModel: environment.TRANSLATION_SERVED_MODEL,
        profileId: environment.TRANSLATION_PROFILE_ID,
        profileKey: environment.TRANSLATION_PROFILE_KEY,
        profileFingerprint: environment.TRANSLATION_PROFILE_FINGERPRINT,
        engineImageDigest: environment.TRANSLATION_ENGINE_IMAGE_DIGEST,
        workerId: environment.TRANSLATION_WORKER_ID || undefined,
      },
    } : {}),
    ...(embeddingWorkerConfigured ? {
      embeddingWorker: {
        workerOrigin: environment.EMBEDDING_WORKER_ORIGIN,
        modelAlias: environment.EMBEDDING_MODEL_ALIAS,
        servedModel: environment.EMBEDDING_SERVED_MODEL,
        profileId: environment.EMBEDDING_PROFILE_ID,
        profileKey: environment.EMBEDDING_PROFILE_KEY,
        profileFingerprint: environment.EMBEDDING_PROFILE_FINGERPRINT,
        engineImageDigest: environment.EMBEDDING_ENGINE_IMAGE_DIGEST,
        workerId: environment.EMBEDDING_WORKER_ID || undefined,
        transportSecurity: embeddingTransportSecurity,
      },
    } : {}),
    ...((drawingWorkerConfigured || ocrWorkerConfigured || asrWorkerConfigured || translationWorkerConfigured) ? {
      objectGateway: dependencies.objectService.createObjectHandoffGateway(),
    } : {}),
    }) : null;
  } finally {
    drawingWorkerToken?.fill(0);
    embeddingTransportSecurity?.credential.fill(0);
    embeddingTransportSecurity?.customCa.fill(0);
  }
  const computeBackend = dependencies.computeBackend ?? (localWorkerConfigured
    ? new DurableComputeBackend({
      jobService: durableJobService,
      execution: localExecutionBridge,
      realtimeAdmission: dependencies.realtimeAdmission ?? Object.freeze({
        async admit() { throw new PlatformError("realtime_unavailable", "Realtime compute is not configured", { status: 503, retryable: true }); },
        async connect() { throw new PlatformError("realtime_unavailable", "Realtime compute is not configured", { status: 503, retryable: true }); },
        async heartbeat() { throw new PlatformError("realtime_unavailable", "Realtime compute is not configured", { status: 503, retryable: true }); },
        async disconnect() { throw new PlatformError("realtime_unavailable", "Realtime compute is not configured", { status: 503, retryable: true }); },
      }),
    })
    : null);
  if (computeBackend && !dependencies.computeBackend) computeBackend.startReconciler();
  const computeApi = dependencies.computeApi ?? (computeBackend ? new ComputeHttpApi({ backend: computeBackend,
    drawingProfileId: environment.DRAWING_PROFILE_ID ?? null }) : null);
  const assistantGatewayConfigured = Boolean(environment.ASSISTANT_COMPUTE_GATEWAY_ORIGIN
    || environment.ASSISTANT_COMPUTE_MODEL || environment.ASSISTANT_COMPUTE_TOKEN_FILE);
  if (assistantGatewayConfigured && (!environment.ASSISTANT_COMPUTE_GATEWAY_ORIGIN
    || !environment.ASSISTANT_COMPUTE_MODEL || !environment.ASSISTANT_COMPUTE_TOKEN_FILE)) {
    throw new TypeError("Assistant compute gateway origin, model, and token file must be configured together");
  }
  const answerRunner = dependencies.assistantAnswerRunner ?? (localWorkerConfigured
    ? new QueuedAssistantAnswerRunner({ computeApi, modelAlias: environment.LOCAL_OPENAI_MODEL_ALIAS })
    : assistantGatewayConfigured
    ? new OpenAiQueuedAnswerRunner({
      computeGatewayOrigin: environment.ASSISTANT_COMPUTE_GATEWAY_ORIGIN,
      model: environment.ASSISTANT_COMPUTE_MODEL,
      tokenProvider: async () => {
        if (!environment.ASSISTANT_COMPUTE_TOKEN_FILE.startsWith("/")) {
          throw new TypeError("ASSISTANT_COMPUTE_TOKEN_FILE must be an absolute path");
        }
        const raw = await readFile(environment.ASSISTANT_COMPUTE_TOKEN_FILE);
        try {
          return raw.toString("utf8").trim();
        } finally {
          raw.fill(0);
        }
      },
    })
    : unavailableRunner);
  const agentBridgeRoutes = dependencies.assistantAgentBridgeRoutes ?? (
    environment.ASSISTANT_AGENT_BRIDGES_FILE
      ? await loadAssistantAgentBridgeRoutes(environment.ASSISTANT_AGENT_BRIDGES_FILE, {
        provisioner: environment.ASSISTANT_AGENT_CONTROLLER_ORIGIN ? createDynamicAgentRoutes({
          origin: environment.ASSISTANT_AGENT_CONTROLLER_ORIGIN,
          tokenFile: environment.ASSISTANT_AGENT_CONTROLLER_TOKEN_FILE,
        }) : null,
      })
      : null
  );
  if (agentBridgeRoutes && !dependencies.database && !dependencies.agentSessionService) {
    throw new TypeError("Assistant Agent Bridge routes require PostgreSQL session persistence");
  }
  const agentSessionService = dependencies.agentSessionService ?? (agentBridgeRoutes
    ? new AgentSessionService({
      repository: new PostgresAgentSessionRepository({ database: dependencies.database }),
      audit,
    })
    : null);
  const agentRunner = dependencies.assistantAgentRunner ?? (agentBridgeRoutes
    ? new OpenCodeAssistantAgentRunner({
      sessionService: agentSessionService,
      bridgeRoutes: agentBridgeRoutes,
      artifactStore: dependencies.objectService?.createObjectHandoffGateway?.() ?? null,
    })
    : unavailableRunner);
  const routingPolicy = localWorkerConfigured
    ? fixedAssistantRoutingPolicy({
      model: environment.LOCAL_OPENAI_MODEL_ALIAS,
      profileKey: environment.LOCAL_OPENAI_PROFILE_KEY || null,
      providerKey: "platform.scheduler",
      targetKind: "internal",
    })
    : assistantGatewayConfigured
    ? fixedAssistantRoutingPolicy({
      model: environment.ASSISTANT_COMPUTE_MODEL,
      profileKey: environment.ASSISTANT_COMPUTE_PROFILE_KEY || null,
      providerKey: environment.ASSISTANT_COMPUTE_PROVIDER_KEY || "platform.compute",
      targetKind: environment.ASSISTANT_COMPUTE_TARGET_KIND || "internal",
    })
    : undefined;
  const taskCenter = dependencies.taskCenter ?? new TaskCenter({
    repository: dependencies.database
      ? new PostgresAgentTaskCenterRepository({ database: dependencies.database })
      : new MemoryTaskCenterRepository(),
  });
  const assistantService = new AssistantService({
    repository: dependencies.assistantRepository ?? (dependencies.database
      ? new PostgresAssistantRepository({ database: dependencies.database })
      : new MemoryAssistantRepository()),
    answerRunner,
    agentRunner,
    taskCenter,
    ...(routingPolicy ? { routingPolicy } : {}),
    audit,
    ...(artifactProvenance ? { artifactHandoff: new AssistantArtifactHandoff({ provenanceService: artifactProvenance }) } : {}),
  });
  const modelAdministration = dependencies.database
    ? createModelAdministration({
      database: dependencies.database,
      evidenceReader: dependencies.modelEvidenceReader ?? null,
      objectService: dependencies.objectService ?? null,
      audit,
    })
    : null;
  const teamDriveService = dependencies.teamDriveService ?? (
    dependencies.database && artifactProvenance && dependencies.objectService?.createObjectHandoffGateway
      ? (() => {
        const objectGateway = dependencies.objectService.createObjectHandoffGateway();
        return new TeamDriveService({
          repository: dependencies.fileRepository ?? new PostgresFileRepository({ database: dependencies.database }),
          objectReferences: {
            resolve: (input) => objectGateway.resolve(input),
            issueReadReference: ({ actorIdentityId, objectId, objectVersion, audience, expiresInSeconds }) => objectGateway.issue({
              actorIdentityId, objectId, objectVersion, audience,
              operations: ["head", "read", "range"], expiresInSeconds,
            }),
          },
          artifactHandoff: new TeamDriveArtifactHandoff({ provenanceService: artifactProvenance }),
          audit,
        });
      })()
      : null
  );
  const teamDriveApi = teamDriveService ? new TeamDriveHttpApi({ service: teamDriveService }) : null;
  const objectApi = dependencies.objectService
    ? new ObjectHttpApi({ service: dependencies.objectService,
      ...(teamDriveService && dependencies.database ? {
        authorizeReference: teamDriveReferenceAccess({
          grants: new PostgresObjectGrantRepository({ database: dependencies.database }), teamDrive: teamDriveService,
        }),
      } : {}),
    }) : null;
  const pluginAccessApi = dependencies.pluginDelegatedUserTokenService && dependencies.database && teamDriveService
    ? new PluginAccessHttpApi({ delegations: dependencies.pluginDelegatedUserTokenService,
      dispatcher: new DelegatedPluginOperationDispatcher({ database: dependencies.database, teamDriveService }) })
    : null;
  const operationalDiagnosticsService = dependencies.operationalDiagnosticsService ?? new OperationalDiagnosticsService({
    repository: dependencies.observabilityRepository ?? (dependencies.database
      ? new PostgresObservabilityRepository({ database: dependencies.database })
      : new MemoryObservabilityRepository()),
    sensitiveContentSource: dependencies.sensitiveDiagnosticContentSource ?? null,
    audit,
  });
  let ownedManagedNodeRuntime = null;
  let ownedMaintenanceRuntime = null;
  let ownedProtectedOfficeSetRuntime = null;
  let ownedProtectedOfficeSetControlHandler = null;
  if (!dependencies.managedNodeService && applianceRuntimeConfigured(environment)) {
    ownedManagedNodeRuntime = await createApplianceRuntimeFromEnvironment(environment, {
      database: dependencies.database,
      audit,
      healthSink: operationalDiagnosticsService,
    });
    dependencies = {
      ...dependencies,
      managedNodeService: ownedManagedNodeRuntime.service,
      managedNodeAgentRouter: ownedManagedNodeRuntime.nodeAgentRouter,
      nodeTransportIdentityResolver: ownedManagedNodeRuntime.nodeTransportIdentityResolver,
      protectedOfficeCatalogRuntime: dependencies.protectedOfficeCatalogRuntime
        ?? ownedManagedNodeRuntime.protectedOfficeCatalogRuntime,
    };
  }
  // Phone storage needs the installed executor created above. Constructing it
  // earlier worked only in tests that injected a router, not a real appliance.
  const storageAdministrationService = dependencies.storageAdministrationService ?? (dependencies.database
    ? new StorageAdministrationService({
      repository: phoneStorageRepositoryFromEnvironment({ environment, database: dependencies.database,
        nodeAgentRouter: dependencies.managedNodeAgentRouter, repository: dependencies.storageAdministrationRepository
        ?? (typeof dependencies.objectService?.createStorageAdministrationRepository === "function"
          ? dependencies.objectService.createStorageAdministrationRepository()
          : new PostgresStorageAdministrationRepository({ database: dependencies.database })) }),
      audit,
    })
    : null);
  if (!dependencies.protectedOfficeSetControlHandler && dependencies.protectedOfficeSetRuntimeFactory) {
    if (!dependencies.database || !dependencies.managedNodeAgentRouter) {
      throw new TypeError("protected office-set runtime requires PostgreSQL and the managed Node Agent router");
    }
    ownedProtectedOfficeSetRuntime = await dependencies.protectedOfficeSetRuntimeFactory(environment, {
      database: dependencies.database,
      nodeAgentRouter: dependencies.managedNodeAgentRouter,
      managedNodeService: dependencies.managedNodeService ?? null,
      protectedOfficeSetProductionBoundaryFactory:
        dependencies.protectedOfficeSetProductionBoundaryFactory ?? null,
      jobService: durableJobService,
      objectService: dependencies.objectService ?? null,
      audit,
      auditService,
      fetcher: dependencies.fetcher ?? fetch,
      publicOrigin,
    });
    const controlHandlerFactory = dependencies.protectedOfficeSetControlHandlerFactory
      ?? createProtectedOfficeSetControlHandler;
    try {
      ownedProtectedOfficeSetControlHandler = await controlHandlerFactory({
        runtime: ownedProtectedOfficeSetRuntime,
        environment,
      });
    } catch (error) {
      await ownedProtectedOfficeSetRuntime?.close?.();
      ownedProtectedOfficeSetRuntime = null;
      throw error;
    }
    dependencies = {
      ...dependencies,
      protectedOfficeSetControlHandler: ownedProtectedOfficeSetControlHandler,
    };
  }
  if (!dependencies.maintenanceService && dependencies.maintenanceRuntimeFactory) {
    ownedMaintenanceRuntime = await dependencies.maintenanceRuntimeFactory(environment, {
      database: dependencies.database,
      managedNodeService: dependencies.managedNodeService,
      managedNodeAgentRouter: dependencies.managedNodeAgentRouter,
    });
    const required = ["maintenanceCatalog", "maintenanceTopologySource", "maintenancePreflightInspector",
      "maintenanceModelCompatibility", "maintenanceDrainController", "maintenanceExecutor", "maintenancePostChecker"];
    if (!ownedMaintenanceRuntime || required.some((key) => !ownedMaintenanceRuntime[key])) throw new TypeError("maintenance runtime is incomplete");
    dependencies = { ...dependencies, ...Object.fromEntries(required.map((key) => [key, ownedMaintenanceRuntime[key]])) };
  }
  const maintenanceAdapters = [dependencies.maintenanceCatalog, dependencies.maintenanceTopologySource, dependencies.maintenancePreflightInspector,
    dependencies.maintenanceModelCompatibility, dependencies.maintenanceDrainController, dependencies.maintenanceExecutor,
    dependencies.maintenancePostChecker];
  const maintenancePartCount = maintenanceAdapters.filter(Boolean).length;
  if (!dependencies.maintenanceService && maintenancePartCount !== 0 && maintenancePartCount !== maintenanceAdapters.length) throw new TypeError("Maintenance workflow adapters must be configured together");
  const maintenanceService = dependencies.maintenanceService ?? (maintenancePartCount === maintenanceAdapters.length ? new MaintenanceWorkflowService({
    repository: dependencies.maintenanceRepository ?? (dependencies.database ? new PostgresMaintenanceRepository({ database: dependencies.database }) : new MemoryMaintenanceRepository()),
    catalog: dependencies.maintenanceCatalog, topologySource: dependencies.maintenanceTopologySource, preflightInspector: dependencies.maintenancePreflightInspector,
    modelCompatibility: dependencies.maintenanceModelCompatibility, drainController: dependencies.maintenanceDrainController,
    executor: dependencies.maintenanceExecutor, postChecker: dependencies.maintenancePostChecker, audit, healthSink: operationalDiagnosticsService,
  }) : null);
  const sourceCenterService = dependencies.sourceCenterService ?? new SourceCenterService({
    repository: dependencies.sourceCenterRepository ?? (dependencies.database
      ? new PostgresSourceCenterRepository({ database: dependencies.database })
      : new MemorySourceCenterRepository()),
    audit,
    healthSink: operationalDiagnosticsService,
  });
  const offlineMediaRepository = dependencies.offlineMediaRepository ?? (dependencies.database
    ? new PostgresOfflineMediaRepository({ database: dependencies.database })
    : new MemoryOfflineMediaRepository());
  const offlineMediaService = dependencies.offlineMediaService ?? new OfflineMediaService({
    repository: offlineMediaRepository,
    discovery: dependencies.offlineMediaDiscovery ?? {
      async listAttached() {
        throw new PlatformError("offline_media_discovery_unavailable", "Offline media discovery is not configured on this appliance", { status: 503, retryable: true });
      },
    },
    inspector: dependencies.offlineMediaInspector ?? {
      async readManifest() { throw new PlatformError("offline_media_inspection_unavailable", "Offline media inspection is not configured on this appliance", { status: 503, retryable: true }); },
      async verifyManifest() { throw new PlatformError("offline_media_inspection_unavailable", "Offline media inspection is not configured on this appliance", { status: 503, retryable: true }); },
      async verifyArtifact() { throw new PlatformError("offline_media_inspection_unavailable", "Offline media inspection is not configured on this appliance", { status: 503, retryable: true }); },
    },
    audit,
  });
  const managedNodeService = dependencies.managedNodeService ?? null;
  const clusterMetricService = dependencies.clusterMetricService ?? (
    managedNodeService && dependencies.database
      ? new ClusterMetricService({
        localNodeId: environment.PLATFORM_APPLIANCE_NODE_ID,
        repository: new PostgresClusterMetricRepository({ database: dependencies.database }),
        managedNodeRepository: new PostgresManagedNodeRepository({ database: dependencies.database, localNodeId: environment.PLATFORM_APPLIANCE_NODE_ID }),
        healthSink: operationalDiagnosticsService,
        onHealthSinkError: async (error, facts) => logger.warn("platform.node_metric_health_sink_failed", { error, ...facts }),
      })
      : null
  );
  const externalProviderService = dependencies.externalProviderService ?? (dependencies.secretStore
    ? new ExternalProviderService({
      repository: externalProviderRepository,
      secretStore: dependencies.secretStore,
      probe: dependencies.externalProviderProbe ?? new ExternalProviderContractTester(),
      audit,
      healthSink: operationalDiagnosticsService,
    })
    : null);
  const externalProviderHealthMonitor = dependencies.externalProviderHealthMonitor ?? (
    dependencies.secretStore && typeof externalProviderRepository.recordHealth === "function"
      ? new ExternalProviderHealthMonitor({
        repository: externalProviderRepository,
        secretStore: dependencies.secretStore,
        audit,
        onObservationError: async (facts) => logger.warn("platform.provider_health_observation_failed", facts),
        intervalMilliseconds: Number(environment.EXTERNAL_PROVIDER_HEALTH_INTERVAL_MILLISECONDS || "10000"),
      })
      : null
  );
  const externalObjectTransferService = dependencies.externalObjectTransferService ?? (
    dependencies.objectService?.createObjectHandoffGateway
      ? new ExternalObjectTransferService({
        repository: dependencies.externalObjectGrantRepository ?? (dependencies.database
          ? new PostgresExternalObjectGrantRepository({ database: dependencies.database })
          : new MemoryExternalObjectGrantRepository()),
        objectGateway: dependencies.objectService.createObjectHandoffGateway(),
        publicOrigin,
        audit,
      })
      : null
  );
  const managedNodeReconciler = managedNodeService ? (dependencies.managedNodeReconciler ?? new ManagedNodeReconciler({
    service: managedNodeService,
    onError: (error) => logger.warn("platform.managed_node_reconcile_failed", { error }),
  })) : null;
  const operationsDashboardService = dependencies.operationsDashboardService ?? (clusterMetricService
    ? new OperationsDashboardService({ clusterMetricService, externalProviderService, localNodeId: environment.PLATFORM_APPLIANCE_NODE_ID })
    : null);
  const baseApplicationCatalogRepository = dependencies.database ? new PostgresApplicationCatalogRepository({
    database: dependencies.database,
    localNodeId: environment.PLATFORM_APPLIANCE_NODE_ID ?? null,
    routingPolicyKey: environment.PLATFORM_MODEL_ROUTING_POLICY_KEY ?? "production.default",
    environment: environment.PLATFORM_MODEL_ROUTING_ENVIRONMENT ?? "production",
  }) : null;
  const protectedCatalogRuntime = dependencies.protectedOfficeCatalogRuntime ?? ownedProtectedOfficeSetRuntime?.components?.nodeAgentRuntime;
  const applicationCatalogRepository = environment.PLATFORM_PROTECTED_OFFICE_SET_ID
      && environment.PLATFORM_APPLICATION_ROUTES_FILE && !dependencies.applicationCatalogService
    ? new ProtectedOfficeCatalogRepository({ repository: baseApplicationCatalogRepository,
      database: dependencies.database, runtime: protectedCatalogRuntime ?? {
        async inspectProtectedProfile() { throw new Error("Protected office inspection is unavailable"); },
      },
      setId: environment.PLATFORM_PROTECTED_OFFICE_SET_ID, nodeId: environment.PLATFORM_PROTECTED_OFFICE_SET_NODE_ID,
      profiles: protectedOfficeCatalogProfiles(environment) }) : baseApplicationCatalogRepository;
  const applicationCatalogService = dependencies.applicationCatalogService ?? (
    dependencies.database && environment.PLATFORM_APPLICATION_ROUTES_FILE && environment.PLATFORM_BUILT_IN_APPLICATIONS_FILE
      ? new ApplicationCatalogService({
        repository: applicationCatalogRepository,
        drawingProfile: drawingWorkerConfigured ? { profileId: environment.DRAWING_PROFILE_ID,
          profileKey: environment.DRAWING_PROFILE_KEY } : null,
        routeSource: new CompositeApplicationRouteSource({ sources: [
          new FileApplicationRouteSource({ path: environment.PLATFORM_APPLICATION_ROUTES_FILE, readinessFetcher: dependencies.fetcher ?? fetch }),
          ...(dependencies.pluginApplicationRouteSource ? [dependencies.pluginApplicationRouteSource] : []),
        ] }),
        builtInSource: new FileBuiltInApplicationSource({ path: environment.PLATFORM_BUILT_IN_APPLICATIONS_FILE }),
      })
      : null
  );
  const userServiceAvailabilitySource = dependencies.userServiceAvailabilitySource ?? (applicationCatalogService
    ? new CatalogUserServiceAvailabilitySource({ applicationCatalogService, clusterMetricService })
    : new ClusterUserServiceAvailabilitySource({ managedNodeService, clusterMetricService, externalProviderService }));
  const userActivityService = dependencies.userActivityService ?? new UserActivityService({
    taskSource: durableJobService ?? taskCenter, availabilitySource: userServiceAvailabilitySource,
  });
  const identityDirectoryService = dependencies.identityDirectoryService ?? new IdentityDirectoryService({ repository });
  const virtualComputers = dependencies.virtualComputers ?? computersFromEnvironment({environment,database:dependencies.database,
    directory:dependencies.virtualComputerIdentityDirectory ?? new RepositoryCastingIdentityDirectory({repository}),
    nodeAgentRouter:dependencies.managedNodeAgentRouter,desktopProvider:dependencies.virtualComputerDesktopProvider,
    objectService:dependencies.objectService??null,teamDrive:teamDriveService});
  if (environment.PLATFORM_VIRTUAL_PHONES_ENABLED !== undefined
    && !["true", "false"].includes(environment.PLATFORM_VIRTUAL_PHONES_ENABLED)) {
    throw new TypeError("PLATFORM_VIRTUAL_PHONES_ENABLED must be true or false");
  }
  const phoneDirectory=dependencies.virtualPhoneIdentityDirectory ?? new RepositoryCastingIdentityDirectory({repository});
  const configuredPhoneMedia=dependencies.database && !dependencies.virtualPhonePeerBridge && !dependencies.virtualPhoneAccessService
    ? await phoneMediaFromEnvironment({environment,database:dependencies.database,nodeAgentRouter:dependencies.managedNodeAgentRouter}) : null;
  const phonePeerBridge=dependencies.virtualPhonePeerBridge ?? configuredPhoneMedia?.peerBridge;
  const phoneSignallingUpstream=dependencies.virtualPhoneSignallingUpstream ?? configuredPhoneMedia?.signallingUpstream;
  const virtualPhoneAccess=dependencies.virtualPhoneAccessService ?? (dependencies.database && phonePeerBridge
    ? new PhoneAccessService({repository:new PostgresPhoneAccessRepository({database:dependencies.database}),
      directory:phoneDirectory,peerBridge:phonePeerBridge}) : null);
  const virtualPhoneMediaGateway=dependencies.virtualPhoneMediaGateway ?? (virtualPhoneAccess && phoneSignallingUpstream
    ? new (await import("../src/virtual-phones/phone-signalling-gateway.mjs")).PhoneSignallingGateway({accessService:virtualPhoneAccess,
      upstream:phoneSignallingUpstream,adbUpstream:dependencies.virtualPhoneAdbUpstream ?? configuredPhoneMedia?.adbUpstream,publicOrigin}) : null);
  const virtualPhoneCamera=dependencies.virtualPhoneCameraService ?? phoneCameraFromEnvironment({environment,database:dependencies.database,
    directory:phoneDirectory,objectService:dependencies.objectService,nodeAgentRouter:dependencies.managedNodeAgentRouter});
  const virtualPhoneAccessRevoker=phoneAccessRevoker({accessService:virtualPhoneAccess,cameraService:virtualPhoneCamera});
  const virtualPhoneService = dependencies.virtualPhoneService ?? (dependencies.database ? new VirtualPhoneService({
    systemReleases: phoneSystemReleasesFromEnvironment(environment),
    repository: new PostgresPhoneRepository({ database: dependencies.database }),
    directory: phoneDirectory,
    capacity: dependencies.virtualPhoneCapacity ?? phoneCapacityFromEnvironment({ environment, database: dependencies.database,
      nodeAgentRouter: dependencies.managedNodeAgentRouter }), runtime: dependencies.virtualPhoneRuntime ?? phoneRuntimeFromEnvironment({environment,
      nodeAgentRouter:dependencies.managedNodeAgentRouter,accessRevoker:virtualPhoneAccessRevoker}),
    policy: { enabled: environment.PLATFORM_VIRTUAL_PHONES_ENABLED === "true" },
  }) : null);
  const phoneFilesRuntime=dependencies.virtualPhoneFileRuntime ?? phoneFilesFromEnvironment({environment,nodeAgentRouter:dependencies.managedNodeAgentRouter});
  const virtualPhoneFiles=dependencies.virtualPhoneFileService ?? (dependencies.database&&dependencies.objectService&&phoneFilesRuntime
    ? new PhoneFileService({repository:new PostgresPhoneRepository({database:dependencies.database}),directory:phoneDirectory,
      sessions:new PostgresPhoneAccessRepository({database:dependencies.database}),
      objectTransfer:new PhoneObjectTransfer({objectService:dependencies.objectService}),runtime:phoneFilesRuntime}):null);
  const identityAdministrationService = dependencies.identityAdministrationService
    ?? new IdentityAdministrationService({ repository, audit });
  const messagingService = dependencies.messagingService ?? new MessagingService({
    repository: dependencies.messagingRepository ?? (dependencies.database
      ? new PostgresMessagingRepository({ database: dependencies.database })
      : new MemoryMessagingRepository()),
    attachmentVerifier: dependencies.messagingAttachmentVerifier ?? {
      async resolveAttachment() {
        throw new PlatformError("messaging_attachment_unavailable", "Messaging attachment storage is unavailable", { status: 503, retryable: true });
      },
      async issueDownloadReference() {
        throw new PlatformError("messaging_attachment_unavailable", "Messaging attachment storage is unavailable", { status: 503, retryable: true });
      },
    },
    audit,
    eventSink: dependencies.messagingEventSink ?? (async () => {}),
  });
  let ownedCastingEphemeralStore = null;
  let ownedCastingRuntime = null;
  let ownedCastingCallback = null;
  const ownsCastingService = !dependencies.castingService;
  let castingAvailability = dependencies.castingAvailability ?? (
    environment.PLATFORM_CASTING_AVAILABILITY_FILE
      ? await FileDisabledCastingAvailability.fromFile(environment.PLATFORM_CASTING_AVAILABILITY_FILE)
      : null
  );
  let castingRuntime = null;
  let castingService = null;
  let castingMediaBoundary = null;
  try {
  castingRuntime = dependencies.castingRuntime ?? (
    trustedMediaRuntimeEnabled
      ? (ownedCastingRuntime = await createTrustedMediaRuntimeFromEnvironment(environment,
        dependencies.trustedMediaRuntimeOptions ?? {}))
      : null
  );
  if (castingRuntime && !environment.PLATFORM_APPLIANCE_NODE_ID) {
    ownedCastingRuntime?.close?.();
    throw new TypeError("PLATFORM_APPLIANCE_NODE_ID is required with the trusted media runtime");
  }
  if (castingRuntime && ownsCastingService) {
    try {
      castingRuntime = await createCastingSessionRuntime(environment, {runtime: castingRuntime});
    } catch (error) {
      ownedCastingRuntime?.close?.();
      throw error;
    }
  }
  if (castingCallbackEnabled) {
    // Construct before the service so one availability object is shared by
    // both HTTP and session-level admission. Calls delegate only after binding.
    const bridge = Object.fromEntries(["pairSource", "markStreaming", "authorizeMediaConnection"]
      .map(name => [name, input => castingService[name](input)]));
    try {
      ownedCastingCallback = await createCastingCallbackRuntimeFromEnvironment(environment, { service: bridge });
      if (castingActivation) castingAvailability = new RuntimeCastingAvailability({
        runtime: castingRuntime, callback: ownedCastingCallback, signallingEnabled: castingSignallingEnabled });
    } catch (error) { ownedCastingRuntime?.close?.(); throw error; }
  }
  castingService = dependencies.castingService ?? (
    castingRuntime && environment.PLATFORM_APPLIANCE_NODE_ID
      ? new CastingSessionService({
        repository: dependencies.castingRepository ?? (dependencies.database
          ? new PostgresCastingRepository({ database: dependencies.database })
          : new MemoryCastingRepository()),
        ephemeralStore: dependencies.castingEphemeralStore ?? (ownedCastingEphemeralStore = new MemoryCastingEphemeralStore()),
        runtime: castingRuntime,
        admission: castingAvailability,
        directory: dependencies.castingIdentityDirectory ?? new RepositoryCastingIdentityDirectory({ repository }),
        applianceNodeId: environment.PLATFORM_APPLIANCE_NODE_ID,
        audit,
      })
      : null
  );
    await castingService?.reconcileStartup?.();
    if (castingSignallingEnabled) castingMediaBoundary = await createCastingMediaBoundaryFromEnvironment(environment, {
        service: castingService, runtime: castingRuntime, publicOrigin,
        authenticateRequest: request => authenticatedContext(request, authentication),
        assertSecureRequest: requireSecureTransport,
      });
    await ownedCastingCallback?.listen();
  } catch (error) {
    await ownedCastingCallback?.close();
    await castingMediaBoundary?.close().catch(() => {});
    if (ownsCastingService) castingService?.close?.();
    ownedCastingRuntime?.close?.();
    if (castingFailurePolicy !== "isolate") throw error;
    // Missing boot-local certificates, a failed SFU, an occupied private
    // port or uncertain old-session cleanup disables only casting. Ordinary
    // office APIs must not become unavailable because this optional service
    // failed. Never release an uncertain reservation or enable a fallback
    // receiver. A controlled Platform restart retries the complete boundary.
    castingRuntime = castingService = castingMediaBoundary = null;
    ownedCastingCallback = ownedCastingRuntime = null;
    ownedCastingEphemeralStore?.close?.();
    ownedCastingEphemeralStore = null;
    castingAvailability = new RuntimeCastingAvailability({
      runtime: { async readiness() { throw new Error("Casting service is unavailable"); } },
      callback: { listening: () => false }, signallingEnabled: false });
    logger.warn("casting.service_start_isolated"); // No raw error/credential/path.
  }
  const server = createPlatformApiServer({
    authentication,
    preferences,
    publicOrigin,
    logger,
    computeApi,
    assistantApi: new AssistantHttpApi({ service: assistantService }),
    modelLifecycleApi: modelAdministration?.httpApi ?? null,
    sourceCenterApi: new SourceCenterHttpApi({ service: sourceCenterService, dataPlaneStatus: environment.PLATFORM_SOURCE_GATEWAY_ORIGIN
      ? new SourceDataPlaneStatusProvider({ gatewayOrigin: environment.PLATFORM_SOURCE_GATEWAY_ORIGIN }) : null }),
    offlineMediaApi: new OfflineMediaHttpApi({ service: offlineMediaService }),
    providerApi: externalProviderService ? new ProviderHttpApi({ service: externalProviderService }) : null,
    routingPolicyApi: new RoutingPolicyHttpApi({ service: routingPolicyRegistry }),
    externalObjectProxyApi: externalObjectTransferService ? new ExternalObjectProxyHttpApi({ service: externalObjectTransferService }) : null,
    applianceAgentApi: managedNodeService ? new ApplianceAgentHttpApi({ service: managedNodeService,
      metricService: clusterMetricService, localNodeId: environment.PLATFORM_APPLIANCE_NODE_ID }) : null,
    operationsApi: new OperationsHttpApi({ service: operationsDashboardService, diagnostics: operationalDiagnosticsService }),
    queueAdministrationApi: queueAdministrationService ? new QueueAdministrationHttpApi({ service: queueAdministrationService }) : null,
    storageAdministrationApi: storageAdministrationService ? new StorageAdministrationHttpApi({ service: storageAdministrationService }) : null,
    encryptionAdministrationApi: encryptionAdministrationService ? new EncryptionAdministrationHttpApi({ service: encryptionAdministrationService }) : null,
    auditApi: new AuditHttpApi({ service: auditService }),
    pluginAdministrationApi: dependencies.pluginAdministrationService
      ? new PluginAdministrationHttpApi({ service: dependencies.pluginAdministrationService }) : null,
    pluginAccessApi,
    maintenanceApi: maintenanceService ? new MaintenanceHttpApi({ service: maintenanceService }) : null,
    userActivityApi: new UserActivityHttpApi({ service: userActivityService }),
    applicationCatalogApi: applicationCatalogService ? new ApplicationCatalogHttpApi({ service: applicationCatalogService }) : null,
    identityDirectoryApi: new IdentityDirectoryHttpApi({ service: identityDirectoryService }),
    identityAdministrationApi: new IdentityAdministrationHttpApi({ service: identityAdministrationService }),
    credentialApi: apiCredentialService ? new CredentialHttpApi({ service: apiCredentialService }) : null,
    messagingApi: new MessagingHttpApi({ service: messagingService }),
    virtualPhoneApi: virtualPhoneService ? new VirtualPhoneHttpApi({ service: virtualPhoneService, accessService:virtualPhoneAccess, fileService:virtualPhoneFiles, cameraService:virtualPhoneCamera, localNodeId:environment.PLATFORM_APPLIANCE_NODE_ID }) : null,
    virtualPhoneMediaGateway,
    virtualComputerApi: dependencies.virtualComputerApi ?? virtualComputers?.api ?? null,
    computerDesktopApi: dependencies.computerDesktopApi ?? virtualComputers?.desktop ?? null,
    castingApi: castingService || castingAvailability
      ? new CastingHttpApi({ service: castingService, availability: castingAvailability,
        mediaAdmission: castingMediaBoundary?.admission ?? null })
      : null,
    castingMediaGateway: castingMediaBoundary?.gateway ?? null,
    protectedOfficeSetControlHandler: dependencies.protectedOfficeSetControlHandler ?? null,
    nodeTransportIdentityResolver: dependencies.nodeTransportIdentityResolver ?? managedNodeTransportIdentity,
    teamDriveApi,
    objectApi,
    credentialAuthentication,
    ownerSetupAuthority,
    ownerRecoveryAuthority,
    realtimeSpeechTransport: dependencies.realtimeSpeechTransport ?? null,
  });
  if (ownedAgentCredentialAuthority) server.once("close", () => ownedAgentCredentialAuthority.close());
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    await ownedCastingCallback?.close();
    await virtualComputers?.close();
    await castingMediaBoundary?.close().catch(() => {});
    ownedAgentCredentialAuthority?.close();
    if (ownsOwnerRecoveryAuthority) ownerRecoveryAuthority.close();
    ownedPluginRuntime?.close?.();
    ownedManagedNodeRuntime?.close?.();
    ownedProtectedOfficeSetControlHandler?.close?.();
    await ownedProtectedOfficeSetRuntime?.close?.();
    ownedMaintenanceRuntime?.close?.();
    ownedEncryptionTransitionRuntime?.close?.();
    if (ownsCastingService) castingService?.close?.();
    ownedCastingRuntime?.close?.();
    localExecutionBridge?.close?.();
    if (ownsExternalProviderExecutionRouter) externalProviderExecutionRouter.close();
    throw error;
  }
  managedNodeReconciler?.start();
  virtualComputers?.start();
  ownedPluginRuntime?.startRecovery?.();
  externalProviderHealthMonitor?.start();
  virtualPhoneService?.startReconciler?.({ onError: error => logger.warn("platform.phone_reconcile_failed", {
    errorCode: error?.code ?? "phone_runtime_unavailable",
  }) });
  virtualPhoneAccess?.startReconciler?.({onError:()=>logger.warn("platform.phone_access_reconcile_failed",{errorCode:"phone_runtime_unavailable"})});
  virtualPhoneCamera?.startReconciler?.({onError:(error)=>logger.warn("platform.phone_camera_reconcile_failed",{errorCode:"phone_camera_runtime_unavailable",
    reason:error?.cameraDiagnosticCode??'phone_camera_runtime_unavailable',action:error?.cameraAction??'reconcile'})});
  server.once("close", () => {
    void virtualComputers?.close();
    void ownedCastingCallback?.close();
    void castingMediaBoundary?.close().catch(() => logger.warn("casting.media_cleanup_pending"));
    managedNodeReconciler?.stop();
    externalProviderHealthMonitor?.stop();
    virtualPhoneService?.stopReconciler?.();
    virtualPhoneAccess?.stopReconciler?.();
    virtualPhoneCamera?.stopReconciler?.();
    if (!dependencies.computeBackend) computeBackend?.stopReconciler?.();
    ownedPluginRuntime?.close?.();
    ownedManagedNodeRuntime?.close?.();
    ownedProtectedOfficeSetControlHandler?.close?.();
    void ownedProtectedOfficeSetRuntime?.close?.();
    ownedMaintenanceRuntime?.close?.();
    ownedEncryptionTransitionRuntime?.close?.();
    if (ownsCastingService) castingService?.close?.();
    ownedCastingRuntime?.close?.();
    localExecutionBridge?.close?.();
    if (ownsExternalProviderExecutionRouter) externalProviderExecutionRouter.close();
    if (ownsAuditSigner) auditSigner.close();
    if (ownsOwnerSetupAuthority) ownerSetupAuthority.close();
    if (ownsOwnerRecoveryAuthority) ownerRecoveryAuthority.close();
  });
  logger.info("platform.started", { host, port, publicOrigin });
  return server;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  startPlatformApi().catch((error) => {
    const logger = createStructuredLogger({ service: "platform-api" });
    logger.error("platform.start_failed", { error });
    process.exitCode = 1;
  });
}

export const authenticatedPlatformPaths = AUTHENTICATED_PATHS;

import http from "node:http";
import { pathToFileURL } from "node:url";

import { requireAdminControl, adminControls } from "../../apps/platform-api/src/authorization/admin-control-guard.mjs";
import { AuthorizationService } from "../../apps/platform-api/src/authorization/authorization-service.mjs";
import { MemoryAuthorizationRepository } from "../../apps/platform-api/src/authorization/memory-repository.mjs";
import { LocalAuthentication } from "../../apps/platform-api/src/identity/auth-service.mjs";
import { MemoryIdentityRepository } from "../../apps/platform-api/src/identity/memory-repository.mjs";
import { PasswordHasher } from "../../apps/platform-api/src/identity/password.mjs";
import { MemoryMessagingRepository } from "../../services/messaging/src/memory-repository.mjs";
import { MessagingService } from "../../services/messaging/src/messaging-service.mjs";
import { MemoryBlobStore } from "../../services/object-service/src/memory-blob-store.mjs";
import { MemoryFileRepository } from "../../services/object-service/src/memory-file-repository.mjs";
import { MemoryObjectRepository } from "../../services/object-service/src/memory-repository.mjs";
import { ProtectedObjectService } from "../../services/object-service/src/object-service.mjs";
import { TeamDriveService } from "../../services/object-service/src/team-drive-service.mjs";
import {LeaseManager} from "../../services/scheduler/src/lease-manager.mjs";
import {MemoryLeaseRepository} from "../../services/scheduler/src/memory-lease-repository.mjs";

const OWNER = "11111111-1111-4111-8111-111111111111";
const MEMBER = "22222222-2222-4222-8222-222222222222";
const NAMESPACE = `user:${OWNER}`;
const SERVICES = new Set(["platform-api", "web", "object-service", "messaging", "scheduler"]);

function invariant(value, message) {
  if (!value) throw new Error(message);
}

async function identityObjective() {
  const authentication = await LocalAuthentication.create({
    repository: new MemoryIdentityRepository(),
    hasher: new PasswordHasher({ memory: 8192, passes: 2, parallelism: 2, tagLength: 32 }),
  });
  const password = "survival validation owner passphrase";
  await authentication.bootstrapOwner({ loginName: "survival-owner", displayName: "Survival Owner", password });
  const session = await authentication.signIn({ loginName: "survival-owner", password, networkIdentifier: "validation-loopback" });
  return async () => {
    const authenticated = await authentication.authenticateSession({
      sessionToken: session.sessionToken, csrfToken: session.csrfToken, requireCsrf: true,
    });
    invariant(authenticated.identityId === session.identity.id, "identity session changed");
    invariant(authenticated.permissions.includes("identity:manage"), "identity permission disappeared");
    return { identityId: authenticated.identityId, sessionActive: true };
  };
}

async function administrationObjective() {
  const authorization = new AuthorizationService({
    repository: new MemoryAuthorizationRepository([{
      id: OWNER, status: "active", identityKind: "local_user",
      roleBindings: [{ roleKey: "owner", scopeKind: "appliance", scopeKey: "*" }],
      serviceGrants: [],
    }]),
  });
  return async () => {
    for (const control of Object.keys(adminControls)) {
      await requireAdminControl(authorization, { identityId: OWNER, control, access: "view" });
    }
    return { controlsAuthorized: Object.keys(adminControls).length };
  };
}

async function messagingObjective() {
  const service = new MessagingService({
    repository: new MemoryMessagingRepository(),
    attachmentVerifier: {
      async resolveAttachment() { return null; },
      async issueDownloadReference() { return null; },
    },
  });
  const owner = { actorIdentityId: OWNER, actorKind: "local_user", permissions: ["message:read", "message:write", "message:manage"] };
  const conversation = await service.createConversation(owner, { kind: "direct", participantIdentityIds: [OWNER, MEMBER] });
  let sequence = 0;
  return async () => {
    sequence += 1;
    const marker = `survival-${sequence}`;
    const message = await service.sendMessage(owner, conversation.id, { idempotencyKey: marker, content: marker });
    const history = await service.history(owner, conversation.id, { after: message.sequence - 1, limit: 1 });
    const search = await service.search(owner, { query: marker, conversationId: conversation.id, limit: 2 });
    invariant(history[0]?.id === message.id && search[0]?.id === message.id, "messaging objective was not durable or searchable");
    return { conversationId: conversation.id, sequence: message.sequence };
  };
}

async function objectAndFilesObjectives() {
  const objects = new ProtectedObjectService({
    repository: new MemoryObjectRepository({ defaultQuotaBytes: 16 * 2 ** 20 }),
    blobStore: new MemoryBlobStore(), referenceSigningKey: Buffer.alloc(32, 111),
    allowTestPlaintextBlobStore: true,
  });
  const objectContext = {
    identityId: OWNER, identityKind: "local_user",
    namespaceAccess: [{ namespaceKey: NAMESPACE, operations: ["read", "write", "list", "reference:create"] }],
  };
  const seed = await objects.upload({
    context: objectContext, namespaceKey: NAMESPACE, objectKey: "survival/drive-seed.txt",
    contentType: "text/plain", content: Buffer.from("team-drive-survival"),
  });
  const reference = await objects.createScopedReference({
    context: objectContext, namespaceKey: NAMESPACE, objectId: seed.objectId,
    audience: "team-drive.file", operations: ["head", "read", "range"],
    expiresAt: new Date(Date.now() + 15 * 60_000),
  });
  const drive = new TeamDriveService({
    repository: new MemoryFileRepository(), objectReferences: objects.createTeamDriveObjectReferences(),
    defaultQuotaBytes: 16 * 2 ** 20,
  });
  const driveContext = {
    actorIdentityId: OWNER, permissions: ["file:read", "file:write", "file:share", "file:manage"],
    teamRoles: { "team.survival": "owner" },
  };
  const root = await drive.createRoot(driveContext, { scopeKind: "team", scopeKey: "team.survival" });
  const file = await drive.createFile(driveContext, root.id, {
    name: "survival.txt", objectReferenceId: reference.reference.referenceId,
  });
  let version = 0;
  return {
    object: async () => {
      version += 1;
      const content = Buffer.from(`metadata-${version}`);
      const stored = await objects.upload({
        context: objectContext, namespaceKey: NAMESPACE, objectKey: "survival/object-metadata.txt",
        contentType: "text/plain", content,
      });
      const head = await objects.head({ context: objectContext, namespaceKey: NAMESPACE, objectId: stored.objectId });
      const listed = await objects.list({ context: objectContext, namespaceKey: NAMESPACE, prefix: "survival/", limit: 20 });
      invariant(head.version === stored.version && listed.items.some((item) => item.objectId === stored.objectId), "object metadata objective diverged");
      return { objectId: stored.objectId, version: stored.version };
    },
    files: async () => {
      const listed = await drive.list(driveContext, root.id);
      const versions = await drive.versions(driveContext, file.entry.id);
      const search = await drive.search(driveContext, root.id, { query: "survival" });
      const quota = await drive.quota(driveContext, root.id);
      invariant(listed[0]?.id === file.entry.id && versions[0]?.objectId === seed.objectId && search[0]?.id === file.entry.id && quota.usedBytes > 0, "Team Drive objective diverged");
      return { rootId: root.id, fileId: file.entry.id, usedBytes: quota.usedBytes };
    },
  };
}

async function schedulerObjective() {
  return async () => {
    const repository = new MemoryLeaseRepository({
      nodes: [{ nodeId: "probe-node", generation: 1, lifecycleState: "ready", capacity: {} }],
      jobs: [{ jobId: "probe-job", status: "queued", currentAttemptId: null, cancelRequestedAt: null }],
    });
    const manager = new LeaseManager({ repository });
    const lease = await manager.acquire({
      acquisitionKey: "probe", jobId: "probe-job", nodeId: "probe-node", nodeGeneration: 1,
      modelProfileId: "probe-profile", now: new Date(),
      reservation: { cpuMillis: 1, unifiedMemoryBytes: 0, acceleratorUnits: 0,
        codecSessions: 0, storageBytes: 0, networkBitsPerSecond: 0 },
    });
    invariant(lease.state === "active", "scheduler identity objective failed");
    return { state: lease.state };
  };
}

export async function createCoreServiceObjectives(service) {
  if (!SERVICES.has(service)) throw new Error("SERVICE_NAME must identify a core survival service");
  if (service === "platform-api") return Object.freeze({ identity: await identityObjective() });
  if (service === "web") return Object.freeze({ administration: await administrationObjective() });
  if (service === "messaging") return Object.freeze({ messaging: await messagingObjective() });
  if (service === "object-service") return Object.freeze(await objectAndFilesObjectives());
  return Object.freeze({ scheduler: await schedulerObjective() });
}

async function main() {
  const service = process.env.SERVICE_NAME;
  const objectives = await createCoreServiceObjectives(service);
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PORT must be an unprivileged TCP port");
  let draining = false;
  const server = http.createServer(async (request, response) => {
    const send = (status, body) => {
      const content = Buffer.from(JSON.stringify(body));
      response.writeHead(status, { "cache-control": "no-store", "content-type": "application/json", "content-length": content.byteLength });
      response.end(content);
    };
    if (request.method === "GET" && request.url === "/health/ready") return send(draining ? 503 : 200, { status: draining ? "not_ready" : "ready", service, functionalObjectives: Object.keys(objectives) });
    const match = /^\/objective\/([a-z][a-z-]{2,63})$/.exec(request.url ?? "");
    if (request.method !== "POST" || !match || !objectives[match[1]]) return send(404, { error: { code: "not_found" } });
    try { return send(200, { passed: true, service, objective: match[1], detail: await objectives[match[1]]() }); }
    catch (error) { return send(503, { passed: false, service, objective: match[1], error: { name: error?.name ?? "Error" } }); }
  });
  server.listen(port, "0.0.0.0", () => process.stdout.write(`${JSON.stringify({ event: "listening", service, port, objectives: Object.keys(objectives) })}\n`));
  const shutdown = () => { if (draining) return; draining = true; server.close(() => { process.exitCode = 0; }); setTimeout(() => process.exit(1), 10_000).unref(); };
  process.on("SIGTERM", shutdown); process.on("SIGINT", shutdown);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => { process.stderr.write(`${JSON.stringify({ event: "startup_failed", name: error?.name ?? "Error" })}\n`); process.exitCode = 1; });
}

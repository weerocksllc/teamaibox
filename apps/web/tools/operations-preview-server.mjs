#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { applicationPluginSharedAsset } from "../../../packages/application-plugin-runtime/src/static-server.mjs";
import { precisionPreviewResponse } from "./precision-preview-fixtures.mjs";
import { supportedLocaleCodes } from '../../../packages/ui-system/src/locale-registry.mjs';

const root = new URL("../dist/", import.meta.url).pathname;
const pluginRoots = new Map([
  ["official.drawing", new URL("../../drawing-plugin/src/public/", import.meta.url).pathname],
  ["official.ocr", new URL("../../ocr-plugin/src/public/", import.meta.url).pathname],
  ["official.asr", new URL("../../asr-plugin/src/public/", import.meta.url).pathname],
  ["official.translation", new URL("../../translation-plugin/src/public/", import.meta.url).pathname],
  ["official.messaging", new URL("../../messaging-plugin/src/public/", import.meta.url).pathname],
  ["official.team-drive", new URL("../../team-drive-plugin/src/public/", import.meta.url).pathname],
  ["official.virtual-phones", new URL("../../virtual-phones-plugin/src/public/", import.meta.url).pathname],
  ["official.virtual-computers", new URL("../../virtual-computers-plugin/src/public/", import.meta.url).pathname],
  ["official.wireless-casting", new URL("../../wireless-casting-plugin/src/public/", import.meta.url).pathname],
]);
// Local-only UI fixtures. Never imported by a product bundle or a production server.
const previewCatalog = { schemaVersion: 1, applications: [
  ["assistant", "ai-application", "sparkles"], ["drawing", "ai-application", "palette"],
  ["ocr", "ai-application", "scan-text"], ["asr", "ai-application", "audio-lines"],
  ["translation", "ai-application", "languages"], ["messaging", "collaboration", "messages"],
  ["team-drive", "collaboration", "folder"], ["wireless-casting", "collaboration", "cast"],
  ["virtual-phones", "professional", "smartphone"], ["virtual-computers", "professional", "monitor"],
].map(([key, categoryKey, iconKey], order) => ({
  pluginKey: `official.${key}`, installedVersion: "synthetic-ui-preview", lifecycleState: "enabled", authorized: true,
  route: { pathPrefix: `/plugins/official.${key}`, integration: key === "assistant" ? "workbench" : "iframe" }, dependencies: [], capabilities: [], models: [],
  health: { state: "healthy", observedAt: null }, availability: "available", launchable: true, blockers: [],
  ui: { labelKey: `app.${key === "team-drive" ? "drive" : key}.name`, descriptionKey: `app.${key === "team-drive" ? "drive" : key}.description`, iconKey, categoryKey, order, fallbackLabel: key, official: true,
    localization: { supportedLocales: supportedLocaleCodes, fallbackLocale: "zh-CN", supportedDirections: ["ltr","rtl"], rtlReady: true },
    themes: { supported: ["light", "dark"], usesSemanticTokens: true, livePreferenceEvents: true } },
})) };
// Contract-shaped, synthetic drawing choices for UI checks only. No model or job
// execution is provided, and the preview never forwards requests to a box.
const drawingPreview = previewCatalog.applications.find(app => app.pluginKey === "official.drawing");
const drawingProfileId = "00000000-0000-4000-8000-000000000601";
drawingPreview.models = [{ capabilityKey: "image-generation", route: "local", available: true, intentRouter: {
  schema: "teamaibox.drawing-intents.v2", policyVersion: "protected-main-default.v1",
  actualProfileDisclosureRequired: true, externalProcessingDisclosureRequired: false,
  ordinaryPolicy: { fallbackAllowed: false, requiredPlacementClass: "protected-resident", requiredNodeRole: "main-box", selectedProfile: "synthetic.drawing", selectedProfileId: drawingProfileId },
  intents: ["automatic", "fast"].map(intentKey => ({ intentKey, modelAlias: `drawing.${intentKey}`, operation: "images.generations", available: true, reasonCode: null,
    selectedProfile: "synthetic.drawing", selectedProfileId: drawingProfileId, selectedProfileDisplayName: "Synthetic UI preview", certificationState: "certified",
    route: "local", processingLocation: "appliance", placementClass: "protected-resident", nodeRole: "main-box", precision: "Preview only", exclusive: false,
    defaults: { steps: 4, guidanceScale: 1, count: 1 }, constraints: { negativePrompt: false, maskInpainting: false, maximumCount: 1, maximumReferenceImages: 0 },
  })),
} }];
const port = Number(process.env.TEAMAIBOX_PREVIEW_PORT ?? 4174);
const responseDelayMilliseconds = Number(process.env.TEAMAIBOX_PREVIEW_RESPONSE_DELAY_MS ?? 0);
const previewDataState = process.env.TEAMAIBOX_PREVIEW_DATA_STATE ?? "ready";
// Delay just the locale dependency to observe the actual first paint, not only
// the final translated screen. No business request or appliance is involved.
const localeAssetDelay = Number(process.env.TEAMAIBOX_PREVIEW_LOCALE_DELAY_MS ?? 0);
if (!Number.isInteger(localeAssetDelay) || localeAssetDelay < 0 || localeAssetDelay > 10000) throw new TypeError("invalid locale fixture delay");
// Reproduce deployed import metadata, not an idealized all-languages fixture.
// Read-only local preview only; never writes to an appliance or changes services.
if (process.env.TEAMAIBOX_PREVIEW_LEGACY_LOCALES === "1") {
  for (const app of previewCatalog.applications) app.ui.localization = {
    supportedLocales: ['zh-CN', 'en'], fallbackLocale: 'zh-CN', supportedDirections: ['ltr'], rtlReady: false,
  };
}
// Local synthetic startup states: never changes a deployed catalog or service.
if (process.env.TEAMAIBOX_PREVIEW_AI_STARTUP === "1") {
  const states = { assistant: "loading", drawing: "retrying", ocr: "failed", asr: "ready", translation: "unavailable" };
  for (const app of previewCatalog.applications) {
    const state = states[app.pluginKey.split(".")[1]];
    if (!state) continue;
    app.startupState = state;
    app.launchable = state === "ready";
    app.availability = app.launchable ? "available" : "unavailable";
    app.blockers = app.launchable ? [] : ["model_route_unavailable"];
  }
}
if (!Number.isInteger(responseDelayMilliseconds) || responseDelayMilliseconds < 0 || responseDelayMilliseconds > 5000) throw new TypeError("TEAMAIBOX_PREVIEW_RESPONSE_DELAY_MS must be between 0 and 5000");
if (!new Set(["ready", "empty", "error"]).has(previewDataState)) throw new TypeError("TEAMAIBOX_PREVIEW_DATA_STATE must be ready, empty, or error");
const nodeId = "018f6f18-24d7-7c21-9b62-8c0174199502";
const workerId = "018f6f18-24d7-7c21-9b62-8c0174199510";
const profileId = "018f6f18-24d7-7c21-9b62-8c0174199511";
const measured = (value) => ({ status: "measured", value, reasonCode: null, effectiveStatus: "measured" });
const unsupported = (reasonCode) => ({ status: "unsupported", value: null, reasonCode, effectiveStatus: "unsupported" });

const domains = {
  cpu: { logicalCores: measured(20), utilizationPercent: measured(43), load1: measured(4.2) },
  unifiedMemory: { totalBytes: measured(128 * 1024 ** 3), usedBytes: measured(71 * 1024 ** 3), availableBytes: measured(57 * 1024 ** 3), dedicatedAcceleratorMemoryBytes: unsupported("unified_memory_architecture") },
  accelerator: { utilizationPercent: measured(68), temperatureCelsius: measured(62), powerWatts: unsupported("driver_power_metric_unsupported"), powerLimitWatts: unsupported("driver_power_metric_unsupported") },
  storage: { totalBytes: measured(3.6 * 1024 ** 4), usedBytes: measured(1.2 * 1024 ** 4), availableBytes: measured(2.4 * 1024 ** 4), readBytesPerSecond: measured(124 * 1024 ** 2), writeBytesPerSecond: measured(38 * 1024 ** 2) },
  network: { receiveBytesPerSecond: measured(86 * 1024 ** 2), transmitBytesPerSecond: measured(31 * 1024 ** 2), availableBitsPerSecond: measured(10_000_000_000), receiveErrors: measured(0), transmitErrors: measured(0) },
  codecs: { encodeActive: measured(1), encodeCapacity: measured(4), decodeActive: measured(2), decodeCapacity: measured(4) },
};

const metricView = { nodeId, nodeGeneration: 4, sequence: 1842, observedAt: "2026-08-11T12:22:13.000Z", receivedAt: "2026-08-11T12:22:13.180Z", freshness: { status: "fresh", ageMilliseconds: 1180, staleAfterMilliseconds: 30000 }, domains,
  processes: [{ targetKind: "worker", targetId: workerId, cpuPercent: measured(31), unifiedMemoryBytes: measured(36 * 1024 ** 3), cgroupMemoryBytes: measured(36.4 * 1024 ** 3), acceleratorMemoryBytes: unsupported("unified_memory_architecture") }, { targetKind: "core_service", targetId: "platform.api", cpuPercent: measured(4), unifiedMemoryBytes: measured(1.3 * 1024 ** 3), cgroupMemoryBytes: measured(1.4 * 1024 ** 3), acceleratorMemoryBytes: unsupported("not_applicable") }],
  workers: [{ workerId, state: "busy", profileId, jobId: "018f6f18-24d7-7c21-9b62-8c0174199512", cpuPercent: measured(31), unifiedMemoryBytes: measured(36 * 1024 ** 3), acceleratorUtilizationPercent: measured(68) }],
  models: [{ profileId, state: "loaded", workerId, unifiedMemoryBytes: measured(34 * 1024 ** 3), loadMilliseconds: measured(8400) }],
  jobs: { queued: measured(12), preparing: measured(1), running: measured(3), succeeded: measured(843), failed: measured(2), cancelled: measured(7) },
  queues: [{ queueKey: "drawing.batch", depth: measured(12), oldestWaitMilliseconds: measured(48000), reasons: [{ reasonCode: "model_loading", count: 8 }, { reasonCode: "unified_memory_reserved", count: 4 }] }],
  reservations: { cpuMillis: measured(8000), unifiedMemoryBytes: measured(42 * 1024 ** 3), acceleratorUnits: measured(1), codecSessions: measured(1), storageBytes: measured(0), networkBitsPerSecond: measured(500_000_000) },
  coreServices: [{ serviceKey: "platform.api", state: "healthy", availabilityPercent: measured(100), latencyMilliseconds: measured(14), errorRatePercent: measured(0.1) }, { serviceKey: "object.service", state: "healthy", availabilityPercent: measured(99.99), latencyMilliseconds: measured(18), errorRatePercent: measured(0.03) }],
};

const maintenanceNodeA = { nodeId, nodeKey: "spark-dev-01", lifecycleState: "ready", healthState: "healthy" };

const dashboard = { generatedAt: "2026-08-11T12:22:14.000Z", appliance: { deviceId: nodeId, displayName: "Team AI Box", state: "ready", collectionStatus: "fresh", metrics: metricView },
  externalProviders: { status: "available", reasonCode: null, data: [{ providerId: "018f6f18-24d7-7c21-9b62-8c0174199520", providerKey: "external.a100.lab", displayName: "A100 Lab Pool", lifecycleState: "healthy", freshness: { status: "fresh", observedAt: "2026-08-11T12:22:05.000Z", ageMilliseconds: 9000, staleAfterMilliseconds: 90000 }, health: { state: "healthy", errorCode: null, latencyMilliseconds: measured(23) }, metrics: { concurrencyLimit: { status: "configured", value: 8, reasonCode: null }, activeRequests: { status: "unavailable", value: null, reasonCode: "provider_active_requests_unavailable" }, requestsPerMinuteLimit: { status: "configured", value: 120, reasonCode: null }, tokensPerMinuteLimit: { status: "configured", value: 2000000, reasonCode: null }, cpu: unsupported("external_provider_hardware_not_exposed"), unifiedMemory: unsupported("external_provider_hardware_not_exposed"), accelerator: unsupported("external_provider_hardware_not_exposed"), temperaturePower: unsupported("external_provider_hardware_not_exposed") }, modelMappings: [{ modelProfileId: profileId, operations: ["responses", "chat.completions"], contextWindow: 131072, enabled: true }] }] },
  alerts: [{ alertId: "queue:drawing.batch:queue_backlog", severity: "warning", code: "queue_backlog", scope: { kind: "queue", id: "drawing.batch" }, titleKey: "operations.alert.queue_backlog", detailKey: "operations.alert.queue_backlog_detail", facts: { nodeId, depth: 12, reasons: ["model_loading", "unified_memory_reserved"] } }],
};

const activity = { generatedAt: "2026-08-11T12:22:14.000Z", availability: [
  { applicationKey: "official.assistant", capabilityKey: "assistant", state: "available", reasonKey: "services.reason.ready", wait: { estimateStatus: "estimated", estimatedSeconds: 0, basis: "no_queue" }, observedAt: "2026-08-11T12:22:14.000Z" },
  { applicationKey: "official.drawing", capabilityKey: "drawing", state: "busy", reasonKey: "services.reason.busy", wait: { estimateStatus: "estimated", estimatedSeconds: 48, basis: "queue_age_proxy" }, observedAt: "2026-08-11T12:22:14.000Z" },
  { applicationKey: "official.ocr", capabilityKey: "ocr", state: "available", reasonKey: "services.reason.ready", wait: { estimateStatus: "estimated", estimatedSeconds: 0, basis: "no_queue" }, observedAt: "2026-08-11T12:22:14.000Z" },
  { applicationKey: "official.asr", capabilityKey: "asr", state: "busy", reasonKey: "services.reason.busy", wait: { estimateStatus: "estimated", estimatedSeconds: 19, basis: "queue_age_proxy" }, observedAt: "2026-08-11T12:22:14.000Z" },
  { applicationKey: "official.translation", capabilityKey: "translation", state: "available", reasonKey: "services.reason.ready", wait: { estimateStatus: "estimated", estimatedSeconds: 0, basis: "no_queue" }, observedAt: "2026-08-11T12:22:14.000Z" },
], tasks: [
  { taskId: "018f6f18-24d7-7c21-9b62-8c0174199531", taskKind: "asr", titleKey: "tasks.kind.asr", state: "running", progress: 68, progressRevision: 1, cancellationRequested: false, wait: { reasonKey: null, estimateStatus: "not_applicable", estimatedSeconds: null }, failure: null, results: [], canCancel: true, createdAt: "2026-08-11T11:00:00.000Z", updatedAt: "2026-08-11T12:20:00.000Z", terminalAt: null },
  { taskId: "018f6f18-24d7-7c21-9b62-8c0174199532", taskKind: "drawing", titleKey: "tasks.kind.drawing", state: "preparing", progress: 12, progressRevision: 1, cancellationRequested: false, wait: { reasonKey: "tasks.wait.model_loading", estimateStatus: "estimated", estimatedSeconds: 48 }, failure: null, results: [], canCancel: true, createdAt: "2026-08-11T12:19:00.000Z", updatedAt: "2026-08-11T12:21:00.000Z", terminalAt: null },
  { taskId: "018f6f18-24d7-7c21-9b62-8c0174199533", taskKind: "ocr", titleKey: "tasks.kind.ocr", state: "completed", progress: 100, progressRevision: 1, cancellationRequested: false, wait: { reasonKey: null, estimateStatus: "not_applicable", estimatedSeconds: null }, failure: null, results: [{ label: "result", artifactRef: "artifact:v1:ocr-result" }], canCancel: false, createdAt: "2026-08-11T10:00:00.000Z", updatedAt: "2026-08-11T10:03:00.000Z", terminalAt: "2026-08-11T10:03:00.000Z" },
], summary: { total: 3, active: 2, waiting: 1, failed: 0 } };

// Explicit UI-only variants for task reading, not executable jobs. Keep the
// normal fixture unchanged unless this loopback preview option is requested.
if (process.env.TEAMAIBOX_PREVIEW_TASK_VARIANTS === "1") {
  activity.tasks.push(...["failed", "cancelled", "queued"].map((state, index) => ({
    ...activity.tasks[0], taskId: `00000000-0000-4000-8000-00000000070${index}`,
    taskKind: "translation", titleKey: "tasks.kind.translation", state,
    progress: state === "queued" ? 0 : 32, canCancel: state === "queued",
    failure: state === "failed" ? { code: "synthetic_failure", guidanceKey: "tasks.failure.retry_later", retryable: true, retryAction: null } : null,
    terminalAt: state === "queued" ? null : activity.generatedAt,
  })));
  activity.summary = { total: 6, active: 3, waiting: 2, failed: 1 };
}

const operationalHealth = [
  { healthId: "018f6f18-24d7-7c21-9b62-8c0174199561", correlationId: "request-health-12345678", target: { kind: "provider", key: "external.a100.lab" }, state: "healthy", reasonCode: null, observedAt: "2026-08-11T12:22:05.000Z", facts: { healthState: "healthy", latencyMilliseconds: 23 }, signalId: "018f6f18-24d7-7c21-9b62-8c0174199571" },
  { healthId: "018f6f18-24d7-7c21-9b62-8c0174199562", correlationId: "request-health-22345678", target: { kind: "software_source", key: "pip.public.cache" }, state: "healthy", reasonCode: null, observedAt: "2026-08-11T12:21:57.000Z", facts: { healthState: "healthy", latencyMilliseconds: 8 }, signalId: "018f6f18-24d7-7c21-9b62-8c0174199572" },
  { healthId: "018f6f18-24d7-7c21-9b62-8c0174199563", correlationId: "request-diagnostic-12345678", target: { kind: "storage_pool", key: "objects.nvme.primary" }, state: "degraded", reasonCode: "pool_io_latency", observedAt: "2026-08-11T12:21:48.000Z", facts: { healthState: "degraded", reasonCode: "pool_io_latency" }, signalId: "018f6f18-24d7-7c21-9b62-8c0174199573" },
];
const operationalAlerts = [{ alertId: "018f6f18-24d7-7c21-9b62-8c0174199581", alertKey: "worker-circuit:qwen:worker", severity: "critical", status: "open", target: { kind: "worker", key: workerId }, correlationId: "request-diagnostic-12345678", titleKey: "operations.alert.worker_circuit_open", detailKey: "operations.alert.worker_circuit_open_detail", facts: { reasonCode: "model_load_crash", crashCount: 3 }, signalIds: ["018f6f18-24d7-7c21-9b62-8c0174199574"], jobIds: ["018f6f18-24d7-7c21-9b62-8c0174199512"], occurrenceCount: 1, openedAt: "2026-08-11T12:20:00.000Z", lastSeenAt: "2026-08-11T12:20:00.000Z", resolvedAt: null }];
const auditEvents = [
  [6, "security.lost_usb_revoked", "security", "succeeded", "recovery", "018f6f18-24d7-7c21-9b62-8c0174199596"],
  [5, "agent.operation_proposed", "agent_confirmation", "succeeded", "agent_operation", "018f6f18-24d7-7c21-9b62-8c0174199595"],
  [4, "routing_policy.updated", "routing", "succeeded", "policy", "018f6f18-24d7-7c21-9b62-8c0174199594"],
  [3, "provider.contract_tested", "provider", "failed", "provider", "018f6f18-24d7-7c21-9b62-8c0174199593"],
  [2, "plugin.sandbox.denied", "plugin", "denied", "plugin", "example.team-notes"],
  [1, "identity.owner_bootstrapped", "identity", "succeeded", "identity", "018f6f18-24d7-7c21-9b62-8c017419958b"],
].map(([sequenceId, action, domain, outcome, resourceKind, resourceId], index) => ({ sequenceId, schemaVersion: 1, eventId: `018f6f18-24d7-7c21-9b62-8c01741996${String(index).padStart(2, "0")}`, occurredAt: `2026-08-11T12:${String(25 - index).padStart(2, "0")}:00.000Z`, actor: { identityId: "018f6f18-24d7-7c21-9b62-8c017419958b", kind: "administrator" }, action, domain, outcome, resource: { kind: resourceKind, id: resourceId }, correlationId: `request-audit-${String(sequenceId).padStart(8, "0")}`, metadata: {}, previousEventHash: sequenceId === 1 ? null : `sha256:${"a".repeat(64)}`, eventHash: `sha256:${String(sequenceId).repeat(64).slice(0, 64)}`, checkpoint: { algorithm: "hmac-sha256", keyId: "audit.primary.v1", signature: `hmac-sha256:${"b".repeat(64)}` } }));
const backupComponents = ["configuration", "postgresql", "encrypted_objects", "plugin_metadata", "model_metadata", "audit_evidence", "protected_keys"].map((component, index) => ({ component, mediaType: "application/octet-stream", itemCount: [14, 112, 2841, 8, 21, 96, 5][index], plaintextBytes: [148000, 382000000, 48600000000, 1900000, 5400000, 620000, 48000][index], ciphertextBytes: [148000, 382000000, 48600000000, 1900000, 5400000, 620000, 48000][index], plaintextDigest: `sha256:${String(index + 1).repeat(64).slice(0, 64)}`, ciphertextDigest: `sha256:${String(index + 2).repeat(64).slice(0, 64)}`, encryptionAlgorithm: "aes-256-gcm", keyId: "backup.recovery.v1" }));
const backupSet = { backupSetId: "018f6f18-24d7-7c21-9b62-8c0174199599", target: { targetKey: "usb.archive", displayName: "USB Backup · 4 TB", kind: "filesystem", failureDomain: "media.usb.1", enabled: true, independent: true }, state: "completed", checkpoint: { schemaVersion: 1, checkpointId: "checkpoint.20260811.001", recoveryPointAt: "2026-08-11T11:58:00.000Z", postgresLsn: "1A/2B", objectSequence: 2841, auditSequence: 96, auditEventHash: auditEvents[0].eventHash, sourceFailureDomains: ["appliance.primary"], sourceStoragePoolIds: ["018f6f18-24d7-7c21-9b62-8c0174199508"], sourceDeviceIdentityDigests: [`sha256:${"d".repeat(64)}`] }, components: backupComponents, manifest: { digest: `sha256:${"e".repeat(64)}`, algorithm: "hmac-sha256", keyId: "backup.recovery.v1", signature: `hmac-sha256:${"f".repeat(64)}` }, totalCiphertextBytes: backupComponents.reduce((sum, item) => sum + item.ciphertextBytes, 0), failureCode: null, requestedBy: "018f6f18-24d7-7c21-9b62-8c017419958b", startedAt: "2026-08-11T11:55:00.000Z", updatedAt: "2026-08-11T12:02:00.000Z", completedAt: "2026-08-11T12:02:00.000Z" };
const restoreDestinations = [{ destinationKey: "rehearsal.isolated", displayName: "隔离恢复容器", kind: "disposable_container", disposable: true, enabled: true }, { destinationKey: "appliance.live", displayName: "当前在线设备", kind: "live_appliance", disposable: false, enabled: true }];
const recoveryEvidence = { schemaVersion: 1, integrityPassed: true, manifestDigest: backupSet.manifest.digest, verifiedComponents: backupComponents.map((item) => ({ component: item.component, plaintextDigest: item.plaintextDigest, ciphertextDigest: item.ciphertextDigest, plaintextBytes: item.plaintextBytes, ciphertextBytes: item.ciphertextBytes, itemCount: item.itemCount })),
  restoreValidation: { passed: true, restoredItems: 2985, restoredObjectVersions: 2841 }, recoveryPointAt: backupSet.checkpoint.recoveryPointAt, rpoSeconds: 14520, rtoSeconds: 392, objectives: { rpoSeconds: 86400, rtoSeconds: 14400, rpoMet: true, rtoMet: true }, outsideRecoveryPoint: { status: "available", count: 17, sampleObjectVersionIds: ["018f6f18-24d7-7c21-9b62-8c0174199597"], truncated: true } };
const recoveryRun = { runId: "018f6f18-24d7-7c21-9b62-8c0174199598", backupSetId: backupSet.backupSetId, kind: "restore_rehearsal", destination: restoreDestinations[0], selection: backupComponents.map((item) => item.component), state: "completed", evidence: recoveryEvidence, failureCode: null, policyId: "018f6f18-24d7-7c21-9b62-8c0174199596", requestedBy: backupSet.requestedBy, startedAt: "2026-08-11T12:08:00.000Z", updatedAt: "2026-08-11T12:14:32.000Z", completedAt: "2026-08-11T12:14:32.000Z" };
const integrityRun = { ...recoveryRun, runId: "018f6f18-24d7-7c21-9b62-8c0174199595", kind: "integrity_check", destination: null, policyId: null, evidence: { ...recoveryEvidence, restoreValidation: null }, startedAt: "2026-08-11T12:04:00.000Z", updatedAt: "2026-08-11T12:05:14.000Z", completedAt: "2026-08-11T12:05:14.000Z" };
const rehearsalPolicy = { policyId: recoveryRun.policyId, policyKey: "default.restore.rehearsal", backupTargetKey: "usb.archive", restoreDestinationKey: "rehearsal.isolated", intervalSeconds: 86400, rpoObjectiveSeconds: 86400, rtoObjectiveSeconds: 14400, enabled: true, nextDueAt: "2026-08-12T12:08:00.000Z", lastRunAt: recoveryRun.completedAt, lastRunId: recoveryRun.runId, revision: 3, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: recoveryRun.completedAt };
const backupAdministration = { generatedAt: dashboard.generatedAt, targets: [{ targetKey: "usb.archive", displayName: "USB Backup · 4 TB", kind: "filesystem", failureDomain: "media.usb.1", enabled: true, independent: null }, { targetKey: "nas.archive", displayName: "NAS Archive", kind: "remote_archive", failureDomain: "site.nas.1", enabled: true, independent: null }], backupSets: [backupSet], restoreDestinations, rehearsalPolicies: [rehearsalPolicy], recoveryRuns: [recoveryRun, integrityRun] };
const platformCandidate = { candidateKey: "platform.2026-08", displayName: "Team AI Box 2026.8", kind: "platform", version: "2026.8.1", digest: `sha256:${"7".repeat(64)}`, requiresReboot: false, rollbackAvailable: true, minimumServingNodes: 1 };
const hostCandidate = { candidateKey: "host.dgx-os-7-4", displayName: "DGX OS 7.4 · Driver 580", kind: "host", version: "7.4.1", digest: `sha256:${"8".repeat(64)}`, requiresReboot: true, rollbackAvailable: true, minimumServingNodes: 1 };
const maintenancePlan = { planId: "018f6f18-24d7-7c21-9b62-8c0174199594", kind: "host", candidate: hostCandidate, targetNodes: [maintenanceNodeA], strategy: "single_node_downtime", state: "ready", blockers: [], warnings: [],
  backupEvidence: { backupSetId: backupSet.backupSetId, recoveryRunId: integrityRun.runId, manifestDigest: backupSet.manifest.digest, verifiedAt: integrityRun.completedAt, current: true },
  preflight: { evidenceDigest: `sha256:${"9".repeat(64)}`, passed: true, blockers: [], warnings: [], secureBootCompatible: true, runtimeCompatible: true },
  compatibility: { evidenceDigest: `sha256:${"a".repeat(64)}`, incompatibleProfileIds: [], requiresRevalidationProfileIds: [profileId] }, revalidationDecision: "fence_and_revalidate",
  recoveryInstructions: ["Boot the recorded previous DGX OS entry and verify the node agent before resuming services."], rollbackInstructions: ["Restore the recorded driver and container-runtime versions, then run model revalidation."],
  currentNodeId: null, completedNodeIds: [], nodeEvidence: [], postCheck: null, failureCode: null, revision: 1, requestedBy: backupSet.requestedBy, createdAt: "2026-08-11T12:16:00.000Z", updatedAt: "2026-08-11T12:16:00.000Z", completedAt: null };
const maintenanceAdministration = { generatedAt: dashboard.generatedAt, candidates: [platformCandidate, hostCandidate], nodes: [maintenanceNodeA], plans: [maintenancePlan] };
const externalProviderId = "018f6f18-24d7-7c21-9b62-8c0174199520";
let externalProvider = {
  providerId: externalProviderId, providerKey: "lan.h200.research", displayName: "H200 Research Pool",
  endpoint: "https://compute.lan.example/v1", lifecycleState: "healthy",
  auth: { scheme: "bearer", headerName: "Authorization", credentialConfigured: true },
  trust: { mode: "custom_ca", serverName: "compute.lan.example", customCaConfigured: true },
  allowedDataClasses: ["internal", "public"],
  limits: { concurrency: 8, requestsPerMinute: 120, tokensPerMinute: 2000000 },
  timeouts: { connectMilliseconds: 5000, requestMilliseconds: 120000, idleStreamMilliseconds: 30000 },
  executionContract: { idempotencyMode: "provider_key", replayAfterAcceptance: "same_provider", reconcileMode: "none", cancellationMode: "none", sideEffectClass: "none", idempotencyHeader: "Idempotency-Key", statusPathTemplate: null, cancelPathTemplate: null, cancelMethod: null },
  healthCheck: { path: "/models", intervalSeconds: 30, timeoutMilliseconds: 5000, failureThreshold: 3 },
  health: { state: "healthy", latencyMilliseconds: 23, errorCode: null, observedAt: dashboard.generatedAt, consecutiveFailures: 0 },
  contract: { state: "passed", evidenceDigest: `sha256:${"c".repeat(64)}`, testedAt: dashboard.generatedAt, failedChecks: [] },
  costAccounting: { currency: "USD", accountingMode: "unpriced", inputMicrounitsPerMillionTokens: 0, outputMicrounitsPerMillionTokens: 0, imageMicrounitsPerRequest: 0, audioMicrounitsPerMinute: 0 },
  modelMappings: [{ modelProfileId: profileId, providerModelName: "research/giant-llm", operations: ["chat.completions", "responses"], contextWindow: 131072, maximumOutputTokens: 8192, routingWeight: 100, enabled: true }],
  revision: 4, createdBy: backupSet.requestedBy, createdAt: "2026-08-01T00:00:00.000Z", updatedAt: dashboard.generatedAt,
};

const permissions = ["application:catalog:view", "application:catalog:manage", "ai:invoke", "audit:view", "backup:view", "backup:manage", "developer_credential:create", "diagnostic_sensitive:view", "file:read", "file:write", "file:share", "file:manage", "identity:view", "identity:manage", "message:read", "message:write", "message:manage", "model:view", "model:manage", "node:view", "node:manage", "object_reference:revoke:any", "operations:view", "operations:manage", "plugin:view", "plugin:manage", "provider:view", "provider:manage", "queue:view", "queue:manage", "resource_policy:view", "resource_policy:manage", "role:view", "role:manage", "security:view", "security:manage", "service_credential:manage", "source:view", "source:manage", "storage:view", "storage:manage", "task:own:view", "task:own:manage", "team:view", "team:manage", "update:view", "update:manage"];
permissions.push("phone:manage", "computer:manage"); // Local design fixture only; production authorization is unchanged.
const runtime = `globalThis.__TEAM_AI_BOX_RUNTIME__=Object.freeze({apiBase:"/api",classification:"isolated-development-synthetic-only",deploymentSlot:"preview",mode:"development",releaseEvidenceEligible:false,releaseId:"operations-preview",transport:"http"});globalThis.__TEAM_AI_BOX_AUTHORIZATION__=Object.freeze({identityKind:"local_user",permissions:${JSON.stringify(permissions)}});globalThis.__TEAM_AI_BOX_ACCOUNT_PREFERENCES__=Object.freeze({displayName:"产品管理员",loginName:"preview-admin",roles:["owner"],preferredLocale:"zh-CN",preferredTheme:"light"});`;

function json(response, body, status = 200) {
  const send = () => { const bytes = Buffer.from(JSON.stringify(body)); response.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": bytes.length, "cache-control": "no-store" }); response.end(bytes); };
  if (responseDelayMilliseconds > 0) setTimeout(send, responseDelayMilliseconds); else send();
}
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".map": "application/json" };
const pluginStateCss = "[hidden]{display:none!important}\n";

async function servePluginAsset(pathname, response) {
  const match = pathname.match(/^\/plugins\/([a-z][a-z0-9.-]{2,127})(?:\/(.*))?$/);
  const pluginRoot = match ? pluginRoots.get(match[1]) : null;
  if (!match || !pluginRoot) return false;
  const relative = match[2] || "index.html";
  if (relative === 'global-translations.mjs' && localeAssetDelay) await new Promise(resolve => setTimeout(resolve, localeAssetDelay));
  if (relative === 'global-translations.mjs' && process.env.TEAMAIBOX_PREVIEW_LOCALE_FAILURE === '1') {
    response.writeHead(503); response.end('locale fixture unavailable'); return true;
  }
  const shared = applicationPluginSharedAsset(relative);
  if (shared) {
    response.writeHead(200, { "content-type": shared.contentType, "content-length": shared.body.byteLength, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    response.end(shared.body);
    return true;
  }
  const target = normalize(join(pluginRoot, relative));
  if (!target.startsWith(normalize(pluginRoot))) { response.writeHead(404); response.end(); return true; }
  try { if (!(await stat(target)).isFile()) throw new Error("not-file"); }
  catch { response.writeHead(404); response.end(); return true; }
  const extension = extname(target), prefix = extension === ".css" ? pluginStateCss : "";
  response.writeHead(200, { "content-type": types[extension] ?? "application/octet-stream", "cache-control": "no-store" });
  if (prefix) response.write(prefix);
  createReadStream(target).pipe(response);
  return true;
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://preview.invalid").pathname;
  if (pathname === "/ui-components") { response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); createReadStream(new URL("./precision-components.html", import.meta.url)).pipe(response); return; }
  if (pathname === "/runtime-config.js") { response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }); response.end(runtime); return; }
  if (/^\/api\/v1\/assistant\/conversations\/[^/]+\/events$/.test(pathname)) { response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" }); response.write(": synthetic UI connection\n\n"); return; }
  if (await servePluginAsset(pathname, response)) return;
  if (pathname === "/api/v1/applications") { json(response, previewDataState === "empty" && process.env.TEAMAIBOX_PREVIEW_KEEP_CATALOG !== "1" ? { schemaVersion: 1, applications: [] } : previewCatalog); return; }
  if (previewDataState === "error" && pathname.startsWith("/api/")) { json(response, { error: { code: "preview_injected_error", message: "Visual regression error fixture" } }, 503); return; }
  // Optional local-only collaboration fixtures. Never forward cookies or writes,
  // and never use the configured product API or an appliance as a fallback.
  const fixturePort = /^\/api\/v1\/(messaging|identities|session)(?:\/|$)/.test(pathname) ? 4183
    : /^\/api\/v1\/(files|objects)(?:\/|$)/.test(pathname) ? 4184 : null;
  if (fixturePort) {
    if (request.method !== "GET") { json(response, { error: { code: "preview_read_only" } }, 405); return; }
    if (pathname.endsWith("/events")) {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      response.write(": synthetic UI preview, no live messages\n\n");
      return;
    }
    try {
      const fixture = await fetch(`http://127.0.0.1:${fixturePort}${request.url}`, { signal: AbortSignal.timeout(1500) });
      response.writeHead(fixture.status, { "content-type": fixture.headers.get("content-type") || "application/json", "cache-control": "no-store" });
      response.end(Buffer.from(await fixture.arrayBuffer()));
    } catch { json(response, { error: { code: "local_collaboration_fixture_not_running" } }, 503); }
    return;
  }
  const precisionFixture = request.method === "GET" ? precisionPreviewResponse(pathname, previewDataState) : undefined;
  if (precisionFixture !== undefined) { json(response, precisionFixture); return; }
  if (pathname === "/api/v1/admin/appliance") { json(response, dashboard); return; }
  if (pathname === "/api/v1/admin/operations/health") { json(response, { generatedAt: dashboard.generatedAt, data: previewDataState === "empty" ? [] : operationalHealth }); return; }
  if (pathname === "/api/v1/admin/operations/alerts") { json(response, { generatedAt: dashboard.generatedAt, data: previewDataState === "empty" ? [] : operationalAlerts }); return; }
  if (pathname === "/api/v1/admin/providers" && request.method === "GET") { json(response, { object: "list", data: previewDataState === "empty" ? [] : [externalProvider] }); return; }
  if (pathname === "/api/v1/admin/providers" && request.method === "POST") { json(response, externalProvider, 201); return; }
  if (pathname === `/api/v1/admin/providers/${externalProviderId}/test` && request.method === "POST") { externalProvider = { ...externalProvider, revision: externalProvider.revision + 1, health: { ...externalProvider.health, state: "healthy", latencyMilliseconds: 21, observedAt: dashboard.generatedAt }, contract: { ...externalProvider.contract, state: "passed", testedAt: dashboard.generatedAt }, updatedAt: dashboard.generatedAt }; json(response, externalProvider); return; }
  if (pathname === `/api/v1/admin/providers/${externalProviderId}/enable` && request.method === "POST") { externalProvider = { ...externalProvider, revision: externalProvider.revision + 1, lifecycleState: "healthy", updatedAt: dashboard.generatedAt }; json(response, externalProvider); return; }
  if (pathname === `/api/v1/admin/providers/${externalProviderId}/disable` && request.method === "POST") { externalProvider = { ...externalProvider, revision: externalProvider.revision + 1, lifecycleState: "disabled", updatedAt: dashboard.generatedAt }; json(response, externalProvider); return; }
  if (pathname === `/api/v1/admin/providers/${externalProviderId}/credential/rotate` && request.method === "POST") { json(response, { providerId: externalProviderId, credentialConfigured: true, activeVersion: 2, rotatedAt: dashboard.generatedAt }); return; }
  if (pathname.startsWith("/api/v1/admin/operations/correlations/")) { json(response, { correlationId: pathname.split("/").at(-1), signals: [], health: operationalHealth.filter((item) => item.correlationId === pathname.split("/").at(-1)), alerts: operationalAlerts.filter((item) => item.correlationId === pathname.split("/").at(-1)) }); return; }
  if (pathname === "/api/v1/admin/audit/events") { const selected = new URL(request.url ?? "/", "http://preview.invalid").searchParams.get("domain"); const events = previewDataState === "empty" ? [] : selected ? auditEvents.filter((item) => item.domain === selected) : auditEvents; json(response, { object: "list", data: events, hasMore: false, nextCursor: null }); return; }
  if (pathname === "/api/v1/admin/audit/verify") { json(response, { valid: true, verifiedEvents: previewDataState === "empty" ? 0 : auditEvents.length, failedSequenceId: null, reasonCode: null, headEventHash: previewDataState === "empty" ? null : auditEvents[0].eventHash, verifiedAt: dashboard.generatedAt }); return; }
  if (pathname === "/api/v1/admin/backups") { json(response, previewDataState === "empty" ? { generatedAt: dashboard.generatedAt, targets: [], backupSets: [], restoreDestinations: [], rehearsalPolicies: [], recoveryRuns: [] } : backupAdministration); return; }
  if (pathname === "/api/v1/admin/backups/sets" && request.method === "POST") { json(response, backupSet); return; }
  if (pathname.endsWith("/verify") && pathname.startsWith("/api/v1/admin/backups/sets/") && request.method === "POST") { json(response, integrityRun); return; }
  if (pathname === "/api/v1/admin/backups/restore-runs" && request.method === "POST") { json(response, recoveryRun); return; }
  if (pathname === "/api/v1/admin/backups/rehearsal-policies" && request.method === "POST") { json(response, rehearsalPolicy); return; }
  if (pathname === "/api/v1/admin/backups/rehearsals/run-due" && request.method === "POST") { json(response, { completedAt: dashboard.generatedAt, data: [{ policyId: rehearsalPolicy.policyId, runId: recoveryRun.runId, status: "completed", errorCode: null }] }); return; }
  if (pathname === "/api/v1/admin/updates" && request.method === "GET") { json(response, previewDataState === "empty" ? { generatedAt: dashboard.generatedAt, candidates: [], nodes: [], plans: [] } : maintenanceAdministration); return; }
  if (pathname === "/api/v1/admin/updates/plans" && request.method === "POST") { json(response, maintenancePlan); return; }
  if (pathname === `/api/v1/admin/updates/plans/${maintenancePlan.planId}/execute` && request.method === "POST") { json(response, { ...maintenancePlan, state: "completed", revision: 6, completedNodeIds: maintenancePlan.targetNodes.map((item) => item.nodeId), postCheck: { passed: true, evidenceDigest: `sha256:${"b".repeat(64)}` }, completedAt: dashboard.generatedAt }); return; }
  if (pathname === "/api/v1/user/activity") { json(response, previewDataState === "empty" ? { generatedAt: dashboard.generatedAt, availability: [], tasks: [], summary: { total: 0, active: 0, waiting: 0, failed: 0 } } : activity); return; }
  if (pathname.startsWith("/api/")) { json(response, { error: { code: "preview_route_unavailable" } }, 404); return; }
  let target = normalize(join(root, pathname === "/" ? "index.html" : pathname.slice(1)));
  if (!target.startsWith(normalize(root))) { response.writeHead(404); response.end(); return; }
  try { if (!(await stat(target)).isFile()) throw new Error("not-file"); } catch { target = join(root, "index.html"); }
  response.writeHead(200, { "content-type": types[extname(target)] ?? "application/octet-stream", "cache-control": "no-store" });
  createReadStream(target).pipe(response);
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`operations preview: http://127.0.0.1:${port}/admin/device\n`));

#!/usr/bin/env node
/**
 * Read-only mTLS/HMAC probe for the main-box protected-office Node Agent.
 *
 * The script is streamed into the existing Platform container. It accepts one
 * base64 JSON request, reads the Platform's already-mounted controller
 * credentials, invokes either the pre-journal protected-set inspection or the
 * final exact protected-Worker health inspection, and retains no credential bytes or command
 * body in its response.
 */

import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";

import { HmacNodeAgentCommandSigner } from "/opt/teamaibox/services/scheduler/src/node-agent-command-signer.mjs";
import { NodeAgentHttpsTransport } from "/opt/teamaibox/services/scheduler/src/node-agent-https-transport.mjs";
import { NodeAgentWorkerSpecFactory } from "/opt/teamaibox/services/scheduler/src/node-agent-worker-spec-factory.mjs";
import { ProtectedNodeAgentClient } from "/opt/teamaibox/services/scheduler/src/protected-node-agent-client.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const RUN_ID = /^legacy-protected-office-node-agent-(?:root|final|rollback)-[0-9]{8}-a[1-9][0-9]*$/;
const MAXIMUM_INPUT = 32 << 10;
const COMMON_KEYS = [
  "schemaVersion", "runId", "host", "port", "nodeId", "nodeGeneration",
  "expectedServerName", "expectedCertificateFingerprint", "keyId",
  "commandKeyFile", "caFile", "clientCertificateFile", "clientPrivateKeyFile",
  "operation", "correlationId",
];
const REQUIRED_KEYS = Object.freeze({
  "pre-journal-inspect": new Set([
    ...COMMON_KEYS, "inspectionId", "transactionId", "migrationPlanId", "migrationPlanDigest",
  ]),
  "protected-workers-health": new Set([
    ...COMMON_KEYS, "workerIds", "leaseId", "fencingToken",
  ]),
});

function fail(message) { throw new Error(message); }
function codedFailure(code) {
  const error = new Error("protected-office probe failed");
  error.code = code;
  throw error;
}
const FAILURE_CLASSIFICATIONS = new Set([
  "node_agent_connection_refused", "node_agent_name_resolution_failed",
  "node_agent_tls_verification_failed", "node_agent_transport_unavailable",
  "node_agent_command_rejected", "node_agent_protocol_mismatch",
  "probe_credential_access_denied", "probe_runtime_incompatible",
  "probe_response_invalid", "probe_transport_timeout", "probe_process_failed",
]);
function classifyFailure(error) {
  const code = typeof error?.code === "string" ? error.code.toLowerCase() : "";
  const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
  const combined = `${code} ${message}`;
  if (combined.includes("econnrefused") || combined.includes("connection refused")) return "node_agent_connection_refused";
  if (combined.includes("enotfound") || combined.includes("eai_again") || combined.includes("getaddrinfo")) return "node_agent_name_resolution_failed";
  if (combined.includes("certificate fingerprint mismatch") || combined.includes("hostname/ip does not match")
      || combined.includes("unable to verify") || combined.includes("self signed certificate")
      || combined.includes("certificate has expired") || combined.includes("certificate is not yet valid")) {
    return "node_agent_tls_verification_failed";
  }
  if (combined.includes("eacces") || combined.includes("permission denied")) return "probe_credential_access_denied";
  if (combined.includes("is not a function") || combined.includes("err_module_not_found")
      || combined.includes("cannot find module") || combined.includes("does not provide an export")) {
    return "probe_runtime_incompatible";
  }
  if (combined.includes("node_agent_protocol_mismatch")) return "node_agent_protocol_mismatch";
  if (combined.includes("node_agent_transport_unavailable")) return "node_agent_transport_unavailable";
  if (combined.includes("node_agent_transport_rejected") || combined.includes("node_agent_command_failed")
      || combined.includes("worker_health_failed")
      || combined.includes("protected_set_transition_inspection_")
      || combined.includes("unauthorized") || combined.includes("forbidden")) {
    return "node_agent_command_rejected";
  }
  if (combined.includes("etimedout") || combined.includes("timed out") || combined.includes("timeout")) return "probe_transport_timeout";
  if (combined.includes("unexpected token") || combined.includes("invalid json")
      || combined.includes("invalid response")) return "probe_response_invalid";
  return "probe_process_failed";
}
function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}
function absolutePath(value) {
  return typeof value === "string" && value.startsWith("/") && !value.split("/").includes("..");
}

const encoded = process.env.TEAMAIBOX_PROTECTED_OFFICE_PROBE_B64;
delete process.env.TEAMAIBOX_PROTECTED_OFFICE_PROBE_B64;
if (typeof encoded !== "string" || encoded.length < 4 || encoded.length > MAXIMUM_INPUT * 2) {
  fail("protected-office probe input is invalid");
}
const bytes = Buffer.from(encoded, "base64");
if (bytes.byteLength > MAXIMUM_INPUT || bytes.toString("base64") !== encoded) {
  bytes.fill(0);
  fail("protected-office probe input is invalid");
}
let value;
try { value = JSON.parse(bytes.toString("utf8")); }
finally { bytes.fill(0); }

const required = REQUIRED_KEYS[value?.operation];
if (!required || !exactKeys(value, required) || value.schemaVersion !== 1 || !RUN_ID.test(value.runId ?? "")
    || value.host !== "local-node-agent" || value.port !== 9443
    || !UUID.test(value.nodeId ?? "") || !Number.isSafeInteger(value.nodeGeneration)
    || value.nodeGeneration < 1 || !/^spark-local(?:\.[a-z0-9.-]+)?$/.test(value.expectedServerName ?? "")
    || !SHA256.test(value.expectedCertificateFingerprint ?? "")
    || !/^[a-z][a-z0-9_.-]{2,127}$/.test(value.keyId ?? "")
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value.correlationId ?? "")
    || (value.operation === "protected-workers-health"
      && (!Array.isArray(value.workerIds) || value.workerIds.length !== 6
        || new Set(value.workerIds).size !== 6 || value.workerIds.some((item) => !UUID.test(item ?? ""))
        || !UUID.test(value.leaseId ?? "")
        || !Number.isSafeInteger(value.fencingToken) || value.fencingToken < 1))
    || (value.operation === "pre-journal-inspect"
      && (!UUID.test(value.inspectionId ?? "") || !UUID.test(value.transactionId ?? "")
        || !/^[a-z][a-z0-9_.-]{2,127}$/.test(value.migrationPlanId ?? "")
        || !SHA256.test(value.migrationPlanDigest ?? "")))
    || ![value.commandKeyFile, value.caFile, value.clientCertificateFile,
      value.clientPrivateKeyFile].every(absolutePath)) {
  fail("protected-office probe request is outside the reviewed boundary");
}

const protectedValues = [];
let signer;
let transport;
try {
  const rawEncodedKey = await readFile(value.commandKeyFile);
  protectedValues.push(rawEncodedKey);
  let first = 0;
  let last = rawEncodedKey.byteLength;
  while (first < last && [9, 10, 13, 32].includes(rawEncodedKey[first])) first += 1;
  while (last > first && [9, 10, 13, 32].includes(rawEncodedKey[last - 1])) last -= 1;
  const encodedKey = Buffer.from(rawEncodedKey.subarray(first, last));
  protectedValues.push(encodedKey);
  const key = Buffer.from(encodedKey.toString("ascii"), "base64");
  protectedValues.push(key);
  if (key.byteLength < 32 || key.byteLength > 128
      || key.toString("base64") !== encodedKey.toString("ascii")) {
    fail("protected-office command key is invalid");
  }
  const ca = await readFile(value.caFile);
  const certificate = await readFile(value.clientCertificateFile);
  const privateKey = await readFile(value.clientPrivateKeyFile);
  protectedValues.push(ca, certificate, privateKey);
  signer = new HmacNodeAgentCommandSigner({ keyId: value.keyId, key });
  transport = new NodeAgentHttpsTransport({
    host: value.host,
    port: value.port,
    expectedServerName: value.expectedServerName,
    expectedCertificateFingerprint: value.expectedCertificateFingerprint,
    ca,
    certificate,
    privateKey,
  });
  if (value.operation === "pre-journal-inspect") {
    // Use the stable signer + HTTPS transport surface directly.  Older live
    // Platform images do not expose ProtectedNodeAgentClient's newer
    // inspectProtectedSetTransition convenience method, but do carry these
    // two reviewed primitives and the same protocol v1 envelope.
    const issuedAt = new Date();
    const deadlineAt = new Date(issuedAt.getTime() + 60_000);
    const envelope = {
      protocolVersion: 1,
      commandId: value.inspectionId,
      nodeId: value.nodeId,
      nodeGeneration: value.nodeGeneration,
      type: "protected-set.transaction.inspect",
      issuedAt: issuedAt.toISOString(),
      deadlineAt: deadlineAt.toISOString(),
      correlationId: value.correlationId,
      leaseId: value.inspectionId,
      fencingToken: 1,
      idempotency: "keyed",
      payload: {
        inspectionId: value.inspectionId,
        transactionId: value.transactionId,
        migrationPlanId: value.migrationPlanId,
        migrationPlanDigest: value.migrationPlanDigest,
        mode: "success",
      },
    };
    const body = JSON.stringify(envelope);
    const proof = await signer.sign({
      body,
      commandId: envelope.commandId,
      deadlineAt: envelope.deadlineAt,
    });
    if (!proof || typeof proof.keyId !== "string" || typeof proof.nonce !== "string"
        || typeof proof.signature !== "string") codedFailure("node_agent_protocol_mismatch");
    const response = await transport.postCommand({
      path: "/v1/commands",
      body,
      headers: {
        "content-type": "application/json",
        "x-teamaibox-key-id": proof.keyId,
        "x-teamaibox-nonce": proof.nonce,
        "x-teamaibox-signature": proof.signature,
      },
      timeoutMilliseconds: 60_000,
    });
    if (!response || response.commandId !== envelope.commandId
        || response.nodeId !== envelope.nodeId
        || response.nodeGeneration !== envelope.nodeGeneration
        || response.type !== envelope.type
        || response.fencingToken !== envelope.fencingToken
        || response.correlationId !== envelope.correlationId
        || response.status !== "failed"
        || response.errorCode !== "protected_set_transition_inspection_binding_invalid") {
      codedFailure("node_agent_protocol_mismatch");
    }
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      status: "passed",
      transport: "mtls-hmac",
      operation: "protected-set.transaction.inspect",
      expectedOutcome: "fail-closed-before-journal",
      observedErrorCode: response.errorCode,
      mutationCount: 0,
      privacy: { credentialsRetained: false, requestRetained: false },
    })}\n`);
  } else {
    const client = new ProtectedNodeAgentClient({
      nodeId: value.nodeId,
      nodeGeneration: value.nodeGeneration,
      transport,
      commandSigner: signer,
      workerSpecFactory: new NodeAgentWorkerSpecFactory(),
    });
    const authority = {
        leaseId: value.leaseId,
        fencingToken: value.fencingToken,
        nodeGeneration: value.nodeGeneration,
    };
    const result = [];
    for (const workerId of [...value.workerIds].sort()) {
      const item = await client.workerHealth({
        workerId,
        authority,
        correlationId: value.correlationId,
      });
      if (!item || item.workerId !== workerId || !UUID.test(item.modelProfileId ?? "")
          || !SHA256.test(item.configDigest ?? "") || typeof item.image !== "string"
          || item.image.length < 1 || item.image.length > 512
          || item.status !== "running" || item.health !== "healthy"
          || item.placementClass !== "protected-resident") {
        codedFailure("node_agent_protocol_mismatch");
      }
      result.push(item);
    }
    process.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      status: "passed",
      transport: "mtls-hmac",
      operation: "worker.health",
      workers: result.map((item) => ({
        workerId: item.workerId,
        modelProfileId: item.modelProfileId,
        status: item.status,
        health: item.health,
        image: item.image,
        placementClass: item.placementClass,
        configDigest: item.configDigest,
      })),
      privacy: { credentialsRetained: false, requestRetained: false },
    })}\n`);
  }
} catch (error) {
  const classification = classifyFailure(error);
  if (!FAILURE_CLASSIFICATIONS.has(classification)) process.exit(43);
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    status: "failed",
    transport: "mtls-hmac",
    classification,
    signals: [classification],
    privacy: {
      credentialsRetained: false,
      requestRetained: false,
      rawErrorRetained: false,
      pathsRetained: false,
    },
  })}\n`);
  process.exitCode = 42;
} finally {
  signer?.close?.();
  transport?.close?.();
  for (const item of protectedValues) item.fill(0);
}

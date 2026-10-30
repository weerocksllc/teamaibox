import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ProtectedOfficeMaintenanceSignerClient,
  createProtectedOfficeMaintenanceSignerClientFromEnvironment,
} from "../server/protected-office-maintenance-signer-client.mjs";
import { encodeProtectedMaintenanceSignaturePayload } from
  "../../../services/scheduler/src/production-protected-maintenance-signature-verifier.mjs";

const SIGNATURE_VALUE = "A".repeat(86);

function unsigned() {
  return {
    expiresAt: "2026-09-05T03:10:00.000Z",
    transactionId: "00000000-0000-4000-8000-000000000101",
    allowedOperations: ["protected-set.maintenance"],
    workerIds: [
      "00000000-0000-4000-8000-000000000201",
      "00000000-0000-4000-8000-000000000202",
    ],
    issuedAt: "2026-09-05T03:00:00.000Z",
    maintenanceGeneration: 7,
  };
}

function signature(context) {
  const bytes = encodeProtectedMaintenanceSignaturePayload({
    context,
    operation: "protected-set.maintenance",
  });
  try {
    return {
      algorithm: "Ed25519",
      keyId: "protected-office-main-v1",
      payloadDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      value: SIGNATURE_VALUE,
    };
  } finally { bytes.fill(0); }
}

function passed(context, changes = {}) {
  return {
    schemaVersion: 1,
    status: "passed",
    context: {
      issuedAt: context.issuedAt,
      transactionId: context.transactionId,
      workerIds: [...context.workerIds],
      expiresAt: context.expiresAt,
      maintenanceGeneration: context.maintenanceGeneration,
      allowedOperations: [...context.allowedOperations],
      signature: signature(context),
      ...changes,
    },
  };
}

function requestHarness(responder) {
  const calls = [];
  const requestImplementation = (options, callback) => {
    const outgoing = new EventEmitter();
    outgoing.destroy = (error) => outgoing.emit("error", error);
    outgoing.end = (body) => {
      calls.push({ options, body: Buffer.from(body) });
      const result = responder({ options, body: JSON.parse(body.toString("utf8")) });
      const incoming = new EventEmitter();
      incoming.statusCode = result.statusCode ?? 200;
      incoming.headers = result.headers ?? { "content-type": "application/json" };
      incoming.destroy = (error) => incoming.emit("error", error);
      callback(incoming);
      for (const chunk of result.chunks ?? [Buffer.from(JSON.stringify(result.body))]) {
        incoming.emit("data", chunk);
      }
      incoming.emit("end");
    };
    return outgoing;
  };
  return { calls, requestImplementation };
}

async function fixture(t, { endpoints } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "teamaibox-maintenance-client-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const caFile = join(root, "ca.crt");
  const certificateFile = join(root, "client.crt");
  const keyFile = join(root, "client.key");
  const configFile = join(root, "maintenance.json");
  await writeFile(caFile, "CA".repeat(64));
  await writeFile(certificateFile, "CERTIFICATE".repeat(32));
  await writeFile(keyFile, "PRIVATE-KEY".repeat(32), { mode: 0o600 });
  await chmod(keyFile, 0o600);
  await writeFile(configFile, JSON.stringify({
    schemaVersion: 1,
    tls: { caFile, clientCertificateFile: certificateFile, clientKeyFile: keyFile },
    endpoints: endpoints ?? [{
      nodeKey: "spark-local",
      host: "maintenance-controller",
      port: 9446,
      serverName: "spark-local",
    }],
    candidates: [],
  }));
  return { root, configFile };
}

test("loads one explicit endpoint and uses bounded TLS 1.3 mTLS signing", async (t) => {
  const files = await fixture(t);
  const harness = requestHarness(({ body }) => ({ body: passed(body) }));
  const client = await createProtectedOfficeMaintenanceSignerClientFromEnvironment({
    PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE: files.configFile,
    PLATFORM_PROTECTED_OFFICE_SET_MAINTENANCE_ENDPOINT_KEY: "spark-local",
  }, {
    requestImplementation: harness.requestImplementation,
    checkServerIdentityImplementation: () => undefined,
  });
  const result = await client.sign(unsigned());
  assert.deepEqual(result, signature(unsigned()));
  assert.equal(Object.isFrozen(result), true);
  assert.equal(harness.calls.length, 1);
  const [{ options, body }] = harness.calls;
  assert.equal(options.host, "maintenance-controller");
  assert.equal(options.port, 9446);
  assert.equal(options.servername, "spark-local");
  assert.equal(options.path, "/v1/protected-office/sign");
  assert.equal(options.method, "POST");
  assert.equal(options.minVersion, "TLSv1.3");
  assert.equal(options.maxVersion, "TLSv1.3");
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.agent, false);
  assert.equal(options.headers["content-length"], String(body.byteLength));
  assert.equal(options.checkServerIdentity("spark-local", {}), undefined);
  assert.match(options.checkServerIdentity("different-name", {}).message, /server name drifted/);
  assert.ok(options.ca.some((byte) => byte !== 0));
  assert.ok(options.cert.some((byte) => byte !== 0));
  assert.ok(options.key.some((byte) => byte !== 0));
  client.close();
  assert.ok(options.ca.every((byte) => byte === 0));
  assert.ok(options.cert.every((byte) => byte === 0));
  assert.ok(options.key.every((byte) => byte === 0));
  await assert.rejects(client.sign(unsigned()), (error) =>
    error.code === "protected_maintenance_signer_closed");
});

test("rejects missing, ambiguous, and structurally invalid endpoint selection", async (t) => {
  const duplicate = {
    nodeKey: "spark-local", host: "maintenance-controller", port: 9446, serverName: "spark-local",
  };
  const files = await fixture(t, { endpoints: [duplicate, { ...duplicate }] });
  await assert.rejects(createProtectedOfficeMaintenanceSignerClientFromEnvironment({
    PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE: files.configFile,
    PLATFORM_PROTECTED_OFFICE_SET_MAINTENANCE_ENDPOINT_KEY: "spark-local",
  }), /invalid or duplicated/);
  await assert.rejects(createProtectedOfficeMaintenanceSignerClientFromEnvironment({
    PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE: files.configFile,
  }), /endpoint selection/);
});

test("rejects request and response context drift instead of signing a different set", async (t) => {
  const files = await fixture(t);
  const harness = requestHarness(({ body }) => ({ body: passed(body, {
    maintenanceGeneration: body.maintenanceGeneration + 1,
  }) }));
  const client = await createProtectedOfficeMaintenanceSignerClientFromEnvironment({
    PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE: files.configFile,
    PLATFORM_PROTECTED_OFFICE_SET_MAINTENANCE_ENDPOINT_KEY: "spark-local",
  }, {
    requestImplementation: harness.requestImplementation,
    checkServerIdentityImplementation: () => undefined,
  });
  t.after(() => client.close());
  await assert.rejects(client.sign(unsigned()), (error) =>
    error.code === "protected_maintenance_signer_protocol_invalid"
      && /invalid response/.test(error.message));
  await assert.rejects(client.sign({ ...unsigned(), workerIds: [...unsigned().workerIds].reverse() }),
    /not canonical/);
  await assert.rejects(client.sign({ ...unsigned(), unexpected: true }), /context is invalid/);
});

test("rejects oversized, non-JSON, non-200, and digest-drift responses", async () => {
  const endpoint = { nodeKey: "spark-local", host: "maintenance-controller", port: 9446, serverName: "spark-local" };
  const credentials = { ca: Buffer.alloc(64, 1), certificate: Buffer.alloc(64, 2), privateKey: Buffer.alloc(64, 3) };
  for (const responder of [
    () => ({ chunks: [Buffer.alloc((32 << 10) + 1, 1)] }),
    () => ({ chunks: [Buffer.from("not-json")] }),
    () => ({ statusCode: 503, body: { error: { code: "unavailable" } } }),
    ({ body }) => ({ body: passed(body, { signature: { ...signature(body), payloadDigest: `sha256:${"0".repeat(64)}` } }) }),
  ]) {
    const harness = requestHarness(responder);
    const client = new ProtectedOfficeMaintenanceSignerClient({
      endpoint, ...credentials,
      requestImplementation: harness.requestImplementation,
      checkServerIdentityImplementation: () => undefined,
    });
    await assert.rejects(client.sign(unsigned()), (error) =>
      new Set(["protected_maintenance_signer_protocol_invalid", "protected_maintenance_signer_rejected"]).has(error.code));
    client.close();
  }
});

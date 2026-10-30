#!/usr/bin/env node
/**
 * Narrow production adapter boundary for the protected office-set deployment.
 *
 * The Python orchestrator sends one base64-encoded JSON request through stdin-
 * free `docker exec`.  This adapter never implements a second scheduler.  It
 * loads one digest-pinned production driver from the running Platform image;
 * that driver must call the persisted ProtectedOfficeSetCoordinator and the
 * mTLS/HMAC Node Agent transaction boundary.  Tests may inject a driver, but a
 * missing or drifted production driver fails before any action is dispatched.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RUN_ID = /^protected-office-set-deployment(?:-v5)?-[0-9]{8}-a[1-9][0-9]*$/;
const ACTIONS = new Set([
  "preflight", "cold-boot", "concurrent-office", "bounded-maintenance",
  "restart-verify", "mid-sequence-failure", "final-inspect", "recover", "cleanup",
]);
const SENSITIVE_KEY = /(password|secret|token|private.?key|authorization|cookie|prompt|transcript|image.?bytes|audio.?bytes)/i;
const URL_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

function fail(message) { throw new Error(message); }
function digest(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

function uuidBytes(value) { return Buffer.from(value.replaceAll("-", ""), "hex"); }
function bytesUuid(value) {
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function protectedOfficeActionIdentity(runId, action) {
  if (!RUN_ID.test(runId ?? "") || !ACTIONS.has(action)) fail("protected office-set action identity is invalid");
  const name = Buffer.from(`teamaibox:${runId}:${action}:v1`, "utf8");
  const bytes = createHash("sha1").update(Buffer.concat([uuidBytes(URL_NAMESPACE), name])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return Object.freeze({
    actionId: bytesUuid(bytes), idempotencyKey: digest(Buffer.from(`${runId}:${action}:v1`, "utf8")),
  });
}

function exactRequest(value) {
  const expected = value && typeof value === "object" && !Array.isArray(value)
    ? protectedOfficeActionIdentity(value.runId, value.action) : null;
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== 1 || value.protocol !== "teamaibox.protected-office-set-driver.v1"
      || !RUN_ID.test(value.runId ?? "") || !ACTIONS.has(value.action)
      || !UUID.test(value.actionId ?? "") || !SHA256.test(value.idempotencyKey ?? "")
      || value.actionId !== expected?.actionId || value.idempotencyKey !== expected?.idempotencyKey
      || typeof value.nonce !== "string" || !/^[A-Za-z0-9_-]{22,86}$/.test(value.nonce)
      || typeof value.driverModulePath !== "string" || !value.driverModulePath.startsWith("/opt/teamaibox/")
      || !SHA256.test(value.driverModuleDigest ?? "")
      || !value.plan || typeof value.plan !== "object" || Array.isArray(value.plan)) {
    fail("protected office-set adapter request is invalid");
  }
  return structuredClone(value);
}

function assertRedacted(value, path = "result") {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertRedacted(value[index], `${path}[${index}]`);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) fail(`protected office-set adapter returned a sensitive field at ${path}.${key}`);
    assertRedacted(child, `${path}.${key}`);
  }
}

export async function dispatchProtectedOfficeSetAction(request, {
  read = readFile,
  load = async (path) => import(pathToFileURL(path).href),
  environment = process.env,
} = {}) {
  const input = exactRequest(request);
  const source = await read(input.driverModulePath);
  if (digest(source) !== input.driverModuleDigest) fail("protected office-set production driver digest drifted");
  const module = await load(input.driverModulePath);
  if (typeof module.createProtectedOfficeSetDeploymentDriver !== "function") {
    fail("protected office-set production driver factory is unavailable");
  }
  const driver = await module.createProtectedOfficeSetDeploymentDriver({ environment });
  if (!driver || typeof driver[input.action] !== "function") {
    await driver?.close?.();
    fail("protected office-set production driver does not implement the requested action");
  }
  try {
    const result = await driver[input.action]({
      runId: input.runId,
      action: input.action,
      actionId: input.actionId,
      idempotencyKey: input.idempotencyKey,
      nonce: input.nonce,
      plan: structuredClone(input.plan),
    });
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      fail("protected office-set production driver returned an invalid result");
    }
    assertRedacted(result);
    return Object.freeze({
      schemaVersion: 1,
      protocol: "teamaibox.protected-office-set-driver.v1",
      runId: input.runId,
      action: input.action,
      actionId: input.actionId,
      idempotencyKey: input.idempotencyKey,
      nonce: input.nonce,
      status: "passed",
      result: structuredClone(result),
    });
  } finally {
    await driver.close?.();
  }
}

async function main() {
  const encoded = process.env.TEAMAIBOX_PROTECTED_OFFICE_SET_REQUEST_B64;
  if (typeof encoded !== "string" || encoded.length < 8 || encoded.length > (4 << 20)) {
    fail("protected office-set adapter request is missing");
  }
  let request;
  try {
    request = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch {
    fail("protected office-set adapter request encoding is invalid");
  }
  const response = await dispatchProtectedOfficeSetAction(request);
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`protected office-set adapter failed: ${String(error?.message ?? error).slice(0, 500)}\n`);
    process.exitCode = 1;
  });
}

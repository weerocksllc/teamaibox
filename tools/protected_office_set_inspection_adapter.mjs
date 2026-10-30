#!/usr/bin/env node
/** Digest-pinned, read-only boundary used only by the strict final validator. */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const RUN_ID = /^protected-office-set-deployment(?:-v5)?-[0-9]{8}-a[1-9][0-9]*$/;
const SENSITIVE_KEY = /(password|secret|token|private.?key|authorization|cookie|prompt|transcript|image.?bytes|audio.?bytes)/i;

function fail(message) { throw new Error(message); }
function digest(bytes) { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }

function request(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== 1 || value.protocol !== "teamaibox.protected-office-set-inspection.v1"
      || !RUN_ID.test(value.runId ?? "")
      || typeof value.nonce !== "string" || !/^[A-Za-z0-9_-]{22,86}$/.test(value.nonce)
      || typeof value.inspectorModulePath !== "string" || !value.inspectorModulePath.startsWith("/opt/teamaibox/")
      || !SHA256.test(value.inspectorModuleDigest ?? "")
      || !value.plan || typeof value.plan !== "object" || Array.isArray(value.plan)) {
    fail("protected office-set inspection request is invalid");
  }
  return structuredClone(value);
}

function redacted(value, path = "inspection") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => redacted(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) fail(`protected office-set inspector returned a sensitive field at ${path}.${key}`);
    redacted(child, `${path}.${key}`);
  }
}

export async function inspectProtectedOfficeSet(requestValue, {
  read = readFile,
  load = async (path) => import(pathToFileURL(path).href),
  environment = process.env,
} = {}) {
  const input = request(requestValue);
  const source = await read(input.inspectorModulePath);
  if (digest(source) !== input.inspectorModuleDigest) fail("protected office-set inspector digest drifted");
  const module = await load(input.inspectorModulePath);
  if (typeof module.inspectProtectedOfficeSetDeployment !== "function") {
    fail("protected office-set read-only inspector is unavailable");
  }
  const result = await module.inspectProtectedOfficeSetDeployment({
    runId: input.runId, nonce: input.nonce, plan: structuredClone(input.plan), environment,
  });
  if (!result || typeof result !== "object" || Array.isArray(result)
      || result.readOnly !== true || result.mutationCount !== 0) {
    fail("protected office-set inspector violated the read-only contract");
  }
  redacted(result);
  return Object.freeze({
    schemaVersion: 1, protocol: "teamaibox.protected-office-set-inspection.v1",
    runId: input.runId, nonce: input.nonce, status: "passed", result: structuredClone(result),
  });
}

async function main() {
  const encoded = process.env.TEAMAIBOX_PROTECTED_OFFICE_SET_INSPECTION_B64;
  if (typeof encoded !== "string" || encoded.length < 8 || encoded.length > (4 << 20)) {
    fail("protected office-set inspection request is missing");
  }
  let value;
  try { value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")); }
  catch { fail("protected office-set inspection request encoding is invalid"); }
  process.stdout.write(`${JSON.stringify(await inspectProtectedOfficeSet(value))}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`protected office-set inspection failed: ${String(error?.message ?? error).slice(0, 500)}\n`);
    process.exitCode = 1;
  });
}

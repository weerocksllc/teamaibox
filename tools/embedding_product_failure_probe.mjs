import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import https from "node:https";

const origin = process.env.TEAMAIBOX_CATALOG_PUBLIC_ORIGIN;
const expected = process.env.TEAMAIBOX_EXPECTED_OUTCOME;
const existingJobId = process.env.TEAMAIBOX_EXISTING_JOB_ID || null;
const modelAlias = "local/qwen3-embedding-0.6b";
const profileFingerprint = "sha256:e22cec58a8338e44263ddb94b2d49e50a01d43ecfc71c857c867345468abc89a";
const expect = (condition, message) => { if (!condition) throw new Error(message); };
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function request(path, { method = "GET", session = null, body = null } = {}) {
  const payload = body === null ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const target = new URL(path, origin);
    const req = https.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method,
      rejectUnauthorized: false,
      timeout: 30_000,
      headers: {
        accept: "application/json",
        ...(session ? { cookie: session.cookie } : {}),
        ...(session?.csrf ? { "x-csrf-token": session.csrf } : {}),
        ...(payload ? {
          "content-type": "application/json",
          "content-length": payload.byteLength,
          origin,
        } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    req.on("timeout", () => req.destroy(new Error(`request timeout: ${path}`)));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function signIn() {
  const raw = await readFile("/var/lib/teamaibox-catalog-secrets/owner.json");
  let declaration;
  try { declaration = JSON.parse(raw.toString("utf8")); } finally { raw.fill(0); }
  const response = await request("/api/auth/sign-in", {
    method: "POST", body: { loginName: declaration.loginName, password: declaration.password },
  });
  declaration.password = "[REDACTED]";
  expect(response.status === 200, `sign-in failed: ${response.status}`);
  const value = JSON.parse(response.bytes.toString("utf8"));
  return {
    cookie: (response.headers?.["set-cookie"] ?? []).map((item) => item.split(";", 1)[0]).join("; "),
    csrf: value.csrfToken,
  };
}

async function waitForJob(session, jobId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await request(`/api/v1/jobs/${jobId}`, { session });
    expect(response.status === 200, `job polling failed: ${response.status}`);
    const value = JSON.parse(response.bytes.toString("utf8"));
    if (new Set(["succeeded", "failed", "cancelled", "expired", "incomplete"]).has(value.status)) return value;
    await pause(250);
  }
  throw new Error("job did not reach a terminal state");
}

expect(origin && new Set(["succeeded", "retryable_failure"]).has(expected), "probe configuration is invalid");
const session = await signIn();
let jobId = existingJobId;
if (!jobId) {
  const key = `embedding-failure-probe-${randomUUID()}`;
  const response = await request("/v1/embeddings", {
    method: "POST", session,
    body: {
      model: modelAlias,
      input: `bounded product failure qualification ${randomUUID()}`,
      dimensions: 256,
      x_teamaibox: { background: true, data_class: "confidential", idempotency_key: key },
    },
  });
  expect(response.status === 202, `background submission failed: ${response.status}`);
  jobId = JSON.parse(response.bytes.toString("utf8")).x_teamaibox?.job_id;
  expect(/^[0-9a-f-]{36}$/i.test(jobId ?? ""), "submission lacks a durable job identifier");
}
const job = await waitForJob(session, jobId);
if (expected === "succeeded") {
  expect(job.status === "succeeded" && job.x_teamaibox?.route === "external_provider"
    && job.result?.object === "list" && job.result.data?.[0]?.embedding?.length === 256
    && job.result.x_teamaibox?.profile_fingerprint === profileFingerprint,
  `recovered embedding job is invalid: ${job.status}`);
} else {
  expect(job.status === "failed" && job.x_teamaibox?.route === "external_provider"
    && job.error?.code === "compute_worker_unavailable" && job.error?.retryable === true
    && job.result === null,
  `worker loss did not fail closed: ${job.status}/${job.error?.code ?? "none"}`);
}
process.stdout.write(JSON.stringify({
  schemaVersion: 1,
  status: "passed",
  expectedOutcome: expected,
  observedStatus: job.status,
  route: job.x_teamaibox?.route,
  errorCode: job.error?.code ?? null,
  retryable: job.error?.retryable === true,
  profileFingerprint: job.result?.x_teamaibox?.profile_fingerprint ?? null,
  jobId,
  jobDigest: digest(Buffer.from(jobId)),
  credentialsRetained: false,
  contentRetained: false,
}) + "\n");

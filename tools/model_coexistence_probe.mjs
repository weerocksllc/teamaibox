#!/usr/bin/env node
import { createHash } from "node:crypto";
import net from "node:net";

function argument(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : process.argv[index + 1];
}

const phase = argument("phase");
const rounds = Number(argument("rounds", "12"));
const model = argument("model");
if (!["shared-capabilities", "node-exclusive-llm"].includes(phase)) {
  throw new Error("phase is invalid");
}
if (!Number.isSafeInteger(rounds) || rounds < 3 || rounds > 60) throw new Error("rounds is invalid");
if (phase === "node-exclusive-llm" && (!model || model.length > 200)) throw new Error("model is required");

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

async function timed(name, operation) {
  const started = performance.now();
  try {
    const detail = await operation();
    return { name, passed: true, latencyMilliseconds: Math.round((performance.now() - started) * 1000) / 1000, detail };
  } catch (error) {
    return { name, passed: false, latencyMilliseconds: Math.round((performance.now() - started) * 1000) / 1000, errorClass: error?.name ?? "Error" };
  }
}

async function fetchOk(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

async function coreHttp(host, objective) {
  const response = await fetchOk(`http://${host}:8080/objective/${objective}`, { method: "POST" });
  const value = await response.json();
  if (value?.passed !== true || value?.objective !== objective) throw new Error("service objective failed");
  return { status: response.status };
}

async function tcpReady(host, port) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timeout = setTimeout(() => socket.destroy(new Error("timeout")), 5000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return { connected: true };
}

async function capabilityWork(capability) {
  const response = await fetchOk(`http://${capability}:8080/work`, { method: "POST", body: "" });
  const value = await response.json();
  if (value?.capability !== capability || !/^sha256:[0-9a-f]{64}$/.test(value?.resultDigest ?? "")) {
    throw new Error("capability result integrity failed");
  }
  return { resultDigest: value.resultDigest };
}

async function llmWork() {
  const response = await fetchOk("http://llm:8000/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with exactly: coexistence-ok" }],
      temperature: 0,
      max_tokens: 8,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const value = await response.json();
  const message = value?.choices?.[0]?.message;
  const text = message?.content || message?.reasoning_content;
  if (typeof text !== "string" || text.length === 0) throw new Error("LLM response is missing");
  return {
    responseDigest: digest(text),
    promptTokens: value?.usage?.prompt_tokens ?? null,
    completionTokens: value?.usage?.completion_tokens ?? null,
  };
}

const coreOperations = Object.freeze({
  identity: () => coreHttp("core-platform", "identity"),
  administration: () => coreHttp("core-web", "administration"),
  files: () => coreHttp("core-object", "files"),
  messaging: () => coreHttp("core-messaging", "messaging"),
  database: () => tcpReady("core-postgres", 5432),
  object: () => coreHttp("core-object", "object"),
  queue: async () => {
    const response = await fetchOk("http://core-queue:8222/healthz?js-enabled-only=true");
    return { status: response.status };
  },
});

const coreOperationEvidence = Object.freeze({
  identity: "functional-identity-authentication-and-session",
  administration: "functional-administrator-authorization-guard",
  files: "functional-drive-create-list-version-search-and-quota",
  messaging: "functional-message-send-history-and-search",
  database: "postgresql-connectivity-readiness",
  object: "functional-object-put-head-and-list",
  queue: "jetstream-enabled-readiness",
});

const capabilityOperations = phase === "shared-capabilities"
  ? Object.fromEntries(["drawing", "ocr", "asr", "translation", "realtime-speech-reservation"].map((name) => [name, () => capabilityWork(name)]))
  : { llm: llmWork, "llm-pressure": () => capabilityWork("llm-pressure") };

const observations = [];
for (let ordinal = 1; ordinal <= rounds; ordinal += 1) {
  const operations = { ...coreOperations, ...capabilityOperations };
  const values = await Promise.all(Object.entries(operations).map(([name, operation]) => timed(name, operation)));
  observations.push({ ordinal, values });
  await delay(1000);
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summarize(names) {
  return Object.fromEntries(names.map((name) => {
    const values = observations.flatMap((round) => round.values.filter((item) => item.name === name));
    return [name, {
      probes: values.length,
      failures: values.filter((item) => !item.passed).length,
      latencyMillisecondsP95: percentile(values.map((item) => item.latencyMilliseconds), 0.95),
      resultSequenceDigest: digest(values.filter((item) => item.passed).map((item) => item.detail?.resultDigest ?? item.detail?.responseDigest ?? "ok").join("\n")),
    }];
  }));
}

const core = summarize(Object.keys(coreOperations));
const capabilities = summarize(Object.keys(capabilityOperations));
const passed = [...Object.values(core), ...Object.values(capabilities)].every((item) => item.failures === 0 && item.probes === rounds);
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  phase,
  rounds,
  passed,
  retainPromptOrOutputText: false,
  coreOperationEvidence,
  core,
  capabilities,
  observationsDigest: digest(JSON.stringify(observations)),
})}\n`);
process.exitCode = passed ? 0 : 1;

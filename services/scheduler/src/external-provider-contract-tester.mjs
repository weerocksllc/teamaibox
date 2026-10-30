import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { bufferedMediaResponse } from "../../object-service/src/buffered-media-budget.mjs";

const OCR_PROBE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const OPERATION_PROBES = Object.freeze({
  responses: Object.freeze({ method: "POST", path: "/responses", body: (model) => ({ model, input: "Reply with exactly OK.", max_output_tokens: 8 }) }),
  "chat.completions": Object.freeze({ method: "POST", path: "/chat/completions", body: (model) => ({ model, messages: [{ role: "user", content: "Reply with exactly OK." }], max_tokens: 8 }) }),
  embeddings: Object.freeze({ method: "POST", path: "/embeddings", body: (model) => ({ model, input: "contract probe" }) }),
  "images.generations": Object.freeze({ method: "POST", path: "/images/generations", body: (model) => ({ model, prompt: "A solid blue square", n: 1, size: "256x256" }) }),
  "images.edits": Object.freeze({ method: "POST", path: "/images/edits", body: (model) => ({ model, prompt: "Make the square green", image_b64: OCR_PROBE_PNG, n: 1, size: "256x256" }) }),
  ocr: Object.freeze({ method: "POST", path: "/ocr", body: (model) => ({
    model, file: OCR_PROBE_PNG, fileType: 1, useLayoutDetection: true,
    formatBlockContent: true, layoutShapeMode: "rect", returnMarkdownImages: false, visualize: false,
  }) }),
  translations: Object.freeze({ method: "POST", path: "/translations", body: (model) => ({ model, input: "hello", target_language: "zh" }) }),
});

function providerError(code, message, retryable = true, details = undefined) {
  return new PlatformError(code, message, { status: 502, retryable, details });
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function evidenceDigest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`; }
function endpoint(base, path) {
  const root = new URL(base.endsWith("/") ? base : `${base}/`);
  const prefix = root.pathname.replace(/\/$/, "");
  root.pathname = `${prefix}${path.startsWith("/") ? path : `/${path}`}`;
  return root;
}
function authorizationHeaders(provider, credential) {
  if (provider.auth.scheme === "none") return {};
  if (!(credential instanceof Uint8Array) || credential.byteLength === 0) throw providerError("provider_credential_unavailable", "Provider credential is unavailable", false);
  const value = Buffer.from(credential).toString("utf8");
  return provider.auth.scheme === "bearer"
    ? { Authorization: `Bearer ${value}` }
    : { [provider.auth.headerName]: value };
}
function probeHeaders(value) {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 16) throw providerError("provider_probe_headers_invalid", "Provider probe headers are invalid", false);
  const denied = new Set(["authorization", "cookie", "host", "content-length", "content-type", "connection", "transfer-encoding", "proxy-authorization"]);
  const result = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name) || denied.has(name.toLowerCase()) || typeof headerValue !== "string" || headerValue.length > 1024 || /[\r\n\0]/.test(headerValue)) throw providerError("provider_probe_headers_invalid", "Provider probe headers are invalid", false);
    result[name] = headerValue;
  }
  return result;
}

export class NodeHttpsProviderTransport {
  #maximumResponseBytes;
  constructor({ maximumResponseBytes = Number.MAX_SAFE_INTEGER } = {}) {
    if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1) {
      throw new TypeError("Provider response limit is invalid");
    }
    this.#maximumResponseBytes = maximumResponseBytes;
  }
  async request({ provider, credential, customCa, method, path, body = null, headers = null, timeoutMilliseconds, signal }) {
    const target = endpoint(provider.endpoint, path);
    if (target.protocol !== "https:") throw providerError("provider_transport_policy_denied", "External provider transport must use HTTPS", false);
    if (provider.trust.mode === "custom_ca" && (!(customCa instanceof Uint8Array) || customCa.byteLength === 0)) throw providerError("provider_ca_unavailable", "Provider custom CA is unavailable", false);
    const encoded = body === null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const forwardedHeaders = probeHeaders(headers);
    const started = performance.now();
    try {
      return await new Promise((resolve, reject) => {
        const request = httpsRequest(target, {
          method,
          ca: provider.trust.mode === "custom_ca" ? Buffer.from(customCa) : undefined,
          servername: provider.trust.serverName ?? undefined,
          headers: {
            Accept: "application/json",
            ...forwardedHeaders,
            ...(encoded ? { "Content-Type": "application/json", "Content-Length": String(encoded.byteLength) } : {}),
            ...authorizationHeaders(provider, credential),
          },
          signal,
        }, async (response) => {
          const limit = this.#maximumResponseBytes;
          let raw;
          try {
            raw = await bufferedMediaResponse({
              headers: {get: name => response.headers[name] ?? null},
              body: (async function* () {
                let size = 0;
                for await (const chunk of response) {
                  size += chunk.byteLength;
                  if (size > limit) throw providerError('provider_response_too_large', 'Provider response exceeded the configured limit', false);
                  yield chunk;
                }
              })(),
            });
            let value = null;
            try { if (raw.byteLength) value = JSON.parse(raw.toString('utf8')); }
            catch { throw providerError('provider_response_invalid', 'Provider response was not valid JSON', false); }
            resolve({status: response.statusCode ?? 0, headers: response.headers, body: value,
              latencyMilliseconds: Math.round(performance.now() - started)});
          } catch (error) { response.destroy(); reject(error); }
          finally { raw?.fill(0); }
        });
        request.setTimeout(timeoutMilliseconds, () => request.destroy(providerError("provider_timeout", "Provider request timed out")));
        request.once("error", reject);
        if (encoded) request.end(encoded); else request.end();
      });
    } finally {
      encoded?.fill(0);
    }
  }

  async stream({ provider, credential, customCa, method, path, body = null, headers = null, timeoutMilliseconds, signal }) {
    const target = endpoint(provider.endpoint, path);
    if (target.protocol !== "https:") throw providerError("provider_transport_policy_denied", "External provider transport must use HTTPS", false);
    if (provider.trust.mode === "custom_ca" && (!(customCa instanceof Uint8Array) || customCa.byteLength === 0)) throw providerError("provider_ca_unavailable", "Provider custom CA is unavailable", false);
    const encoded = body === null ? null : Buffer.from(JSON.stringify(body), "utf8");
    const forwardedHeaders = probeHeaders(headers);
    const started = performance.now();
    try {
      return await new Promise((resolve, reject) => {
        const request = httpsRequest(target, {
          method,
          ca: provider.trust.mode === "custom_ca" ? Buffer.from(customCa) : undefined,
          servername: provider.trust.serverName ?? undefined,
          headers: {
            Accept: "text/event-stream",
            ...forwardedHeaders,
            ...(encoded ? { "Content-Type": "application/json", "Content-Length": String(encoded.byteLength) } : {}),
            ...authorizationHeaders(provider, credential),
          },
          signal,
        }, (response) => resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: response,
          latencyMilliseconds: Math.round(performance.now() - started),
        }));
        request.setTimeout(timeoutMilliseconds, () => request.destroy(providerError("provider_timeout", "Provider request timed out")));
        request.once("error", reject);
        if (encoded) request.end(encoded); else request.end();
      });
    } finally {
      encoded?.fill(0);
    }
  }
}

function listModels(response) {
  if (response.status < 200 || response.status >= 300 || response.body?.object !== "list" || !Array.isArray(response.body?.data)) return null;
  const ids = response.body.data.map((item) => item?.id).filter((id) => typeof id === "string");
  return new Set(ids);
}
function operationPassed(operation, response) {
  if (response.status < 200 || response.status >= 300 || !response.body || typeof response.body !== "object") return false;
  if (operation === "responses") return typeof response.body.id === "string" && (Array.isArray(response.body.output) || typeof response.body.output_text === "string" || typeof response.body.status === "string");
  if (operation === "chat.completions") return Array.isArray(response.body.choices) && response.body.choices.length > 0;
  if (operation === "embeddings") return Array.isArray(response.body.data) && Array.isArray(response.body.data[0]?.embedding);
  if (operation === "images.generations" || operation === "images.edits") return Array.isArray(response.body.data) && response.body.data.length > 0;
  if (operation === "ocr") return response.body.errorCode === 0
    && Array.isArray(response.body.result?.layoutParsingResults)
    && response.body.result.layoutParsingResults.length > 0;
  if (operation === "translations") return typeof response.body.text === "string" || typeof response.body.output_text === "string" || Array.isArray(response.body.data);
  return false;
}

export class ExternalProviderContractTester {
  #transport; #fixtureProvider;
  constructor({ transport = new NodeHttpsProviderTransport(), fixtureProvider = null } = {}) {
    if (!transport?.request || (fixtureProvider !== null && typeof fixtureProvider !== "function")) throw new TypeError("External provider contract tester dependencies are invalid");
    this.#transport = transport; this.#fixtureProvider = fixtureProvider;
  }

  async run({ provider, credential = null, customCa = null, signal }) {
    const checks = [], failedChecks = [];
    const request = async (check, input) => {
      try {
        const result = await this.#transport.request({ provider, credential, customCa, timeoutMilliseconds: provider.timeouts.requestMilliseconds, signal, ...input });
        checks.push({ check, status: result.status, latencyMilliseconds: result.latencyMilliseconds, passed: result.status >= 200 && result.status < 300 });
        return result;
      } catch (error) {
        const code = error?.code ?? "provider_transport_failed";
        checks.push({ check, status: null, latencyMilliseconds: null, passed: false, errorCode: code });
        failedChecks.push(`${check}:${code}`);
        return null;
      }
    };
    const health = await request("health", { method: "GET", path: provider.healthCheck.path });
    if (health && (health.status < 200 || health.status >= 300)) failedChecks.push("health:http_status");
    const modelsResponse = provider.healthCheck.path === "/models" ? health : await request("models", { method: "GET", path: "/models" });
    const availableModels = modelsResponse ? listModels(modelsResponse) : null;
    if (!availableModels) failedChecks.push("models:invalid_schema");
    const enabledMappings = provider.modelMappings.filter((item) => item.enabled);
    const probeMapping = async (mapping) => {
      if (availableModels && !availableModels.has(mapping.providerModelName)) failedChecks.push(`model_missing:${mapping.modelProfileId}`);
      for (const operation of mapping.operations) {
        let probe = OPERATION_PROBES[operation] ?? null;
        if (!probe && this.#fixtureProvider) probe = await this.#fixtureProvider({ operation, mapping, provider });
        if (!probe) { failedChecks.push(`fixture_required:${operation}`); continue; }
        const response = await request(`operation:${operation}:${mapping.modelProfileId}`, { method: probe.method, path: probe.path, body: typeof probe.body === "function" ? probe.body(mapping.providerModelName) : probe.body, headers: probe.headers });
        if (response && !operationPassed(operation, response) && probe.validate?.(response) !== true) failedChecks.push(`operation_schema:${operation}:${mapping.modelProfileId}`);
      }
    };
    if (provider.resourceControl?.mode === "model_api") {
      const mappingsByModel = new Map();
      for (const mapping of enabledMappings) {
        const mappings = mappingsByModel.get(mapping.providerModelName) ?? [];
        mappings.push(mapping);
        mappingsByModel.set(mapping.providerModelName, mappings);
      }
      for (const mappings of mappingsByModel.values()) {
        const representative = mappings[0];
        let prepared = false;
        let prepareAttempted = false;
        try {
          prepareAttempted = true;
          const response = await request(`resource_prepare:${representative.modelProfileId}`, {
            method: "POST", path: provider.resourceControl.preparePath,
            body: { model: representative.providerModelName },
          });
          prepared = response !== null && response.status >= 200 && response.status < 300
            && response.body?.status === "ready" && response.body?.loaded === true
            && response.body?.model === representative.providerModelName;
          if (!prepared) {
            failedChecks.push(`resource_prepare_schema:${representative.modelProfileId}`);
            for (const mapping of mappings) {
              for (const operation of mapping.operations) failedChecks.push(`operation_not_probed:${operation}:${mapping.modelProfileId}`);
            }
          } else {
            for (const mapping of mappings) await probeMapping(mapping);
          }
        } finally {
          if (prepareAttempted) {
            const response = await request(`resource_unload:${representative.modelProfileId}`, {
              method: "POST", path: provider.resourceControl.unloadPath,
              body: { model: representative.providerModelName },
            });
            const unloaded = response !== null && response.status >= 200 && response.status < 300
              && response.body?.status === "unloaded" && response.body?.loaded === false
              && response.body?.model === representative.providerModelName;
            if (!unloaded) failedChecks.push(`resource_unload_schema:${representative.modelProfileId}`);
          }
        }
      }
    } else {
      for (const mapping of enabledMappings) await probeMapping(mapping);
    }
    const evidence = {
      schemaVersion: 2,
      providerKey: provider.providerKey,
      endpointOrigin: new URL(provider.endpoint).origin,
      trustMode: provider.trust.mode,
      authScheme: provider.auth.scheme,
      resourceControlMode: provider.resourceControl?.mode ?? null,
      mappings: provider.modelMappings.map((mapping) => ({ modelProfileId: mapping.modelProfileId, operations: [...mapping.operations], enabled: mapping.enabled })),
      checks: checks.map((check) => ({ ...check })).sort((a, b) => a.check.localeCompare(b.check)),
      failedChecks: [...new Set(failedChecks)].sort(),
    };
    return Object.freeze({
      passed: evidence.failedChecks.length === 0,
      evidenceDigest: evidenceDigest(evidence),
      latencyMilliseconds: checks.filter((item) => item.latencyMilliseconds !== null).reduce((maximum, item) => Math.max(maximum, item.latencyMilliseconds), 0) || null,
      failedChecks: Object.freeze(evidence.failedChecks),
      evidence: Object.freeze(evidence),
    });
  }
}

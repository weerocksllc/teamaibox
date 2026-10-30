const TOKEN = /^taibp_v1_[A-Za-z0-9_-]{43}$/;
const PLUGIN_ID = /^[a-z][a-z0-9.-]{2,127}$/;
const SCOPE = /^[a-z][a-z0-9:._-]{2,127}$/;
const OPERATION = /^[a-z][a-z0-9_.-]{2,127}$/;

function invalid(message) { throw new TypeError(message); }

function endpoint(baseUrl) {
  let url;
  try { url = new URL("/api/plugin/v1/invoke", baseUrl); } catch { invalid("platform base URL is invalid"); }
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.search || url.hash) {
    invalid("platform base URL must be an HTTP(S) origin without credentials");
  }
  return url.toString();
}

function resource(value) {
  if (!value || typeof value.kind !== "string" || !/^[a-z][a-z0-9_.-]{1,63}$/.test(value.kind)
    || typeof value.key !== "string" || value.key.length < 1 || value.key.length > 256
    || (value.kind === "appliance" && value.key !== "*")) invalid("delegated resource is invalid");
  return { kind: value.kind, key: value.key };
}

export function createDelegatedPlatformClient({ baseUrl, pluginId, tokenProvider, fetchImpl = globalThis.fetch }) {
  if (!PLUGIN_ID.test(pluginId ?? "") || typeof tokenProvider !== "function" || typeof fetchImpl !== "function") {
    invalid("delegated platform client dependencies are invalid");
  }
  const url = endpoint(baseUrl);
  return Object.freeze({
    async request({ scope, resource: target, operation, body = null, idempotencyKey }) {
      if (typeof scope !== "string" || !SCOPE.test(scope) || typeof operation !== "string" || !OPERATION.test(operation)) {
        invalid("delegated request scope or operation is invalid");
      }
      if (idempotencyKey !== undefined && (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 128)) {
        invalid("delegated request idempotency key is invalid");
      }
      const token = await tokenProvider();
      if (typeof token !== "string" || !TOKEN.test(token)) invalid("delegated token provider returned an invalid token");
      const response = await fetchImpl(url, {
        method: "POST",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-teamaibox-plugin-id": pluginId,
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: JSON.stringify({ schemaVersion: 1, scope, resource: resource(target), operation, body }),
      });
      let document;
      try { document = await response.json(); } catch { throw new Error("platform_api_invalid_response"); }
      if (!response.ok) {
        const error = new Error("platform_api_request_failed");
        error.code = typeof document?.error?.code === "string" ? document.error.code : "platform_api_request_failed";
        error.status = response.status;
        error.retryable = document?.error?.retryable === true;
        throw error;
      }
      return document;
    },
  });
}

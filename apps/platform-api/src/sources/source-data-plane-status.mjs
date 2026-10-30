const ECOSYSTEMS = ["pip", "npm", "apt"];

function origin(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
      || !/^[a-z0-9][a-z0-9.-]{0,126}$/i.test(parsed.hostname) || new Set(["localhost", "127.0.0.1"]).has(parsed.hostname)) {
    throw new TypeError("Source Gateway internal origin is invalid");
  }
  return parsed.origin;
}

function unavailable(errorCode = "source_gateway_unavailable") {
  return Object.freeze({ schemaVersion: 1, state: "unavailable", observedAt: new Date().toISOString(), errorCode,
    ecosystems: Object.freeze(Object.fromEntries(ECOSYSTEMS.map((item) => [item, Object.freeze({ requests: null, cacheHits: null, upstreamFetches: null, upstreamBytes: null })]))) });
}

export class SourceDataPlaneStatusProvider {
  #origin; #fetch; #clock; #timeout;
  constructor({ gatewayOrigin, fetchImplementation = globalThis.fetch, clock = () => new Date(), timeoutMilliseconds = 3_000 }) {
    this.#origin = origin(gatewayOrigin);
    if (typeof fetchImplementation !== "function" || typeof clock !== "function" || !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 100 || timeoutMilliseconds > 10_000) {
      throw new TypeError("Source data-plane status configuration is invalid");
    }
    this.#fetch = fetchImplementation; this.#clock = clock; this.#timeout = timeoutMilliseconds;
  }

  async getStatus() {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), this.#timeout);
    try {
      const response = await this.#fetch(`${this.#origin}/health/ready`, { headers: { accept: "application/json" }, signal: controller.signal });
      if (!response.ok) return unavailable("source_gateway_health_failed");
      const value = await response.json();
      const ecosystems = {};
      for (const ecosystem of ECOSYSTEMS) {
        const item = value?.stats?.[ecosystem];
        if (!item || ["requests", "cacheHits", "upstreamFetches", "upstreamBytes"].some((key) => !Number.isSafeInteger(item[key]) || item[key] < 0)) {
          return unavailable("source_gateway_health_invalid");
        }
        ecosystems[ecosystem] = Object.freeze({ requests: item.requests, cacheHits: item.cacheHits, upstreamFetches: item.upstreamFetches, upstreamBytes: item.upstreamBytes });
      }
      return Object.freeze({ schemaVersion: 1, state: value.status === "ready" ? "ready" : "degraded", observedAt: this.#clock().toISOString(), errorCode: null, ecosystems: Object.freeze(ecosystems) });
    } catch {
      return unavailable();
    } finally { clearTimeout(timer); }
  }
}

export function unavailableSourceDataPlaneStatus() { return unavailable("source_gateway_not_configured"); }

import { readFile } from "node:fs/promises";

const PLUGIN_KEY = /^[a-z][a-z0-9_.-]{1,127}$/;

export class FileApplicationRouteSource {
  #path;
  #fetcher;
  #clock;

  constructor({ path, readinessFetcher = null, clock = () => new Date() }) {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new TypeError("Application route file must use an absolute path");
    }
    this.#path = path;
    if (readinessFetcher !== null && typeof readinessFetcher !== "function") throw new TypeError("Readiness fetcher is invalid");
    this.#fetcher = readinessFetcher;
    this.#clock = clock;
  }

  async routes({ pluginKey = null } = {}) {
    if (pluginKey !== null && !PLUGIN_KEY.test(pluginKey)) throw new TypeError("Application route key is invalid");
    const value = JSON.parse(await readFile(this.#path, "utf8"));
    if (value?.schemaVersion !== 1 || !Array.isArray(value.routes)) {
      throw new TypeError("Application route file is invalid");
    }
    const seen = new Set();
    // Validate the complete administrator-owned file before making any request.
    const routes = value.routes.map((route) => {
      if (!PLUGIN_KEY.test(route?.pluginId) || seen.has(route.pluginId)
          || typeof route.pathPrefix !== "string"
          || route.pathPrefix !== `/plugins/${route.pluginId}`
          || typeof route.origin !== "string") {
        throw new TypeError("Application route entry is invalid");
      }
      const origin = new URL(route.origin);
      if (origin.protocol !== "http:" || origin.username || origin.password
          || origin.pathname !== "/" || origin.search || origin.hash) {
        throw new TypeError("Application route origin is invalid");
      }
      seen.add(route.pluginId);
      return { pluginKey: route.pluginId, pathPrefix: route.pathPrefix, origin: origin.origin };
    });
    return Object.freeze(await Promise.all(routes.filter((route) => pluginKey === null || route.pluginKey === pluginKey).map(async ({ origin, ...route }) => {
      if (!this.#fetcher) return Object.freeze(route);
      let healthy = false, version = null;
      try {
        const response = await this.#fetcher(new URL("/health/ready", origin), {
          method: "GET", redirect: "error", signal: AbortSignal.timeout(2_000),
          headers: { accept: "application/json" },
        });
        if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) throw new Error("Readiness unavailable");
        const reader = response.body.getReader();
        let size = 0;
        const chunks = [];
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 4096) throw new Error("Readiness response exceeds limit");
            chunks.push(part.value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        healthy = body.status === "ready" && body.pluginId === route.pluginKey && typeof body.version === "string";
        version = healthy ? body.version : null;
      } catch { /* A live failure must not fall back to an old database heartbeat. */ }
      return Object.freeze({ ...route, readinessChecked: true, healthy, version, observedAt: this.#clock().toISOString() });
    })));
  }
}

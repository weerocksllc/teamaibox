import { setTimeout as delay } from "node:timers/promises";

import { loadConfiguration } from "../../configuration/src/index.mjs";
import {
  PlatformError,
  correlationIdFromRequest,
  errorResponse,
  runWithCorrelation,
} from "../../observability/src/index.mjs";

const COMPONENT = /^[a-z][a-z0-9-]{2,63}$/;

function timeout(promise, milliseconds, code, message) {
  let handle;
  const deadline = new Promise((_, reject) => {
    handle = setTimeout(() => reject(new PlatformError(code, message, {
      status: 503,
      retryable: true,
    })), milliseconds);
    handle.unref?.();
  });
  return Promise.race([Promise.resolve(promise), deadline]).finally(() => clearTimeout(handle));
}

function normalizedProbe(value) {
  if (value === true) return { ready: true, reason: null };
  if (value === false || value === undefined || value === null) {
    return { ready: false, reason: "not_ready" };
  }
  if (typeof value === "object" && typeof value.ready === "boolean") {
    return {
      ready: value.ready,
      reason: value.ready ? null : (/^[a-z][a-z0-9_]{2,63}$/.test(value.reason ?? "") ? value.reason : "not_ready"),
    };
  }
  return { ready: false, reason: "invalid_probe_result" };
}

export class StartupCoordinator {
  #components = new Map();
  #started = [];
  #state = "idle";
  #failure = null;

  get state() {
    return this.#state;
  }

  register({
    name,
    dependsOn = [],
    start = async () => {},
    stop = async () => {},
    check = async () => true,
    startupTimeoutMs = 30_000,
    probeTimeoutMs = 2_000,
    pollIntervalMs = 100,
  }) {
    if (this.#state !== "idle") throw new PlatformError("lifecycle_locked", "Startup registration is closed", { status: 409 });
    if (!COMPONENT.test(name ?? "")) throw new TypeError("startup component name is invalid");
    if (this.#components.has(name)) throw new TypeError("startup component is duplicated: " + name);
    if (!Array.isArray(dependsOn) || new Set(dependsOn).size !== dependsOn.length || dependsOn.some((item) => !COMPONENT.test(item))) {
      throw new TypeError("startup dependencies are invalid for: " + name);
    }
    for (const operation of [start, stop, check]) {
      if (typeof operation !== "function") throw new TypeError("startup operation is not callable: " + name);
    }
    for (const [field, value] of Object.entries({ startupTimeoutMs, probeTimeoutMs, pollIntervalMs })) {
      if (!Number.isInteger(value) || value < 1 || value > 300_000) {
        throw new TypeError(field + " is outside the safe range for: " + name);
      }
    }
    this.#components.set(name, {
      name,
      dependsOn: [...dependsOn],
      start,
      stop,
      check,
      startupTimeoutMs,
      probeTimeoutMs,
      pollIntervalMs,
    });
    return this;
  }

  #orderedComponents() {
    for (const component of this.#components.values()) {
      for (const dependency of component.dependsOn) {
        if (!this.#components.has(dependency)) {
          throw new PlatformError("missing_dependency", "Startup dependency is not registered", {
            status: 500,
            details: { component: component.name, dependency },
          });
        }
      }
    }
    const permanent = new Set();
    const temporary = new Set();
    const output = [];
    const visit = (name) => {
      if (permanent.has(name)) return;
      if (temporary.has(name)) {
        throw new PlatformError("dependency_cycle", "Startup dependency graph contains a cycle", { status: 500 });
      }
      temporary.add(name);
      const component = this.#components.get(name);
      for (const dependency of component.dependsOn) visit(dependency);
      temporary.delete(name);
      permanent.add(name);
      output.push(component);
    };
    for (const name of this.#components.keys()) visit(name);
    return output;
  }

  async #probe(component) {
    try {
      return normalizedProbe(await timeout(
        component.check(),
        component.probeTimeoutMs,
        "dependency_probe_timeout",
        "A dependency readiness probe timed out",
      ));
    } catch (error) {
      return {
        ready: false,
        reason: error instanceof PlatformError ? error.code : "probe_failed",
      };
    }
  }

  async #waitUntilReady(component) {
    const deadline = Date.now() + component.startupTimeoutMs;
    while (true) {
      const result = await this.#probe(component);
      if (result.ready) return;
      if (Date.now() >= deadline) {
        throw new PlatformError("dependency_not_ready", "A startup dependency did not become ready", {
          status: 503,
          retryable: true,
          details: { component: component.name, reason: result.reason },
        });
      }
      await delay(Math.min(component.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }

  async start() {
    if (this.#state !== "idle") throw new PlatformError("invalid_lifecycle_state", "Service startup has already been attempted", { status: 409 });
    const ordered = this.#orderedComponents();
    this.#state = "starting";
    try {
      for (const component of ordered) {
        await timeout(
          component.start(),
          component.startupTimeoutMs,
          "component_start_timeout",
          "A component start operation timed out",
        );
        this.#started.push(component);
        await this.#waitUntilReady(component);
      }
      this.#state = "running";
    } catch (error) {
      this.#failure = error instanceof PlatformError ? error.code : "startup_failed";
      this.#state = "failed";
      await this.#stopStarted();
      throw error;
    }
  }

  beginDrain() {
    if (this.#state === "running") this.#state = "draining";
  }

  async #stopStarted() {
    const failures = [];
    for (const component of [...this.#started].reverse()) {
      try {
        await timeout(component.stop(), component.startupTimeoutMs, "component_stop_timeout", "A component stop operation timed out");
      } catch {
        failures.push(component.name);
      }
    }
    this.#started = [];
    return failures;
  }

  async stop() {
    if (["stopped", "idle"].includes(this.#state)) {
      this.#state = "stopped";
      return [];
    }
    this.beginDrain();
    const failures = await this.#stopStarted();
    this.#state = "stopped";
    return failures;
  }

  async readiness() {
    if (this.#state !== "running") {
      return {
        ready: false,
        state: this.#state,
        reason: this.#failure ?? (this.#state === "draining" ? "draining" : "startup_incomplete"),
        components: [],
      };
    }
    const results = await Promise.all(this.#started.map(async (component) => ({
      name: component.name,
      ...(await this.#probe(component)),
    })));
    return {
      ready: results.every((result) => result.ready),
      state: this.#state,
      reason: results.every((result) => result.ready) ? null : "dependency_unavailable",
      components: results,
    };
  }
}

function reply(response, status, body, correlationId) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json; charset=utf-8",
    "x-correlation-id": correlationId,
  });
  response.end(payload);
}

export function createHealthHandler({ service, version, coordinator }) {
  if (!COMPONENT.test(service ?? "")) throw new TypeError("health service name is invalid");
  if (typeof version !== "string" || version.length === 0) throw new TypeError("health service version is invalid");
  if (!coordinator || typeof coordinator.readiness !== "function") throw new TypeError("health coordinator is invalid");

  return function healthHandler(request, response) {
    const correlationId = correlationIdFromRequest(request);
    return runWithCorrelation(correlationId, async () => {
      try {
        if (request.method !== "GET") {
          throw new PlatformError("method_not_allowed", "Method not allowed", { status: 405 });
        }
        const pathname = new URL(request.url, "http://service.invalid").pathname;
        if (pathname === "/health/live") {
          reply(response, 200, { status: "ok", service, version }, correlationId);
          return;
        }
        if (pathname === "/health/startup") {
          const started = coordinator.state === "running" || coordinator.state === "draining";
          reply(response, started ? 200 : 503, {
            status: started ? "started" : "not_started",
            service,
            version,
            state: coordinator.state,
          }, correlationId);
          return;
        }
        if (pathname === "/health/ready") {
          const readiness = await coordinator.readiness();
          reply(response, readiness.ready ? 200 : 503, {
            status: readiness.ready ? "ready" : "not_ready",
            service,
            version,
            ...readiness,
          }, correlationId);
          return;
        }
        throw new PlatformError("not_found", "Resource not found", { status: 404 });
      } catch (error) {
        const serialized = errorResponse(error, correlationId);
        reply(response, serialized.status, serialized.body, correlationId);
      }
    });
  };
}

export function loadServiceRuntimeConfiguration(environment = process.env) {
  return loadConfiguration({
    environment,
    prefix: "TEAMAIBOX_",
    schema: {
      serviceName: { type: "string", pattern: COMPONENT },
      port: { type: "integer", minimum: 1024, maximum: 65535, default: 8080 },
      version: { type: "string", pattern: /^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/, default: "0.1.0" },
      shutdownGraceMs: { type: "integer", minimum: 1000, maximum: 300000, default: 10000 },
    },
  });
}

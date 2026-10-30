import http from "node:http";
import { pathToFileURL } from "node:url";

import { createStructuredLogger } from "../../packages/observability/src/index.mjs";
import { createPostgresDatabaseFromEnvironment } from "../../packages/persistence/src/postgres-database.mjs";
import { createHealthHandler, StartupCoordinator } from "../../packages/service-runtime/src/index.mjs";

const COMPONENTS = Object.freeze({
  "object-service": Object.freeze({
    module: "../../services/object-service/src/object-service.mjs",
    exports: Object.freeze(["ProtectedObjectService"]),
  }),
  scheduler: Object.freeze({
    module: "../../services/scheduler/src/routing-engine.mjs",
    exports: Object.freeze(["rankSchedulingCandidates"]),
  }),
  "plugin-runtime": Object.freeze({
    module: "../../services/plugin-runtime/src/manifest-validator.mjs",
    exports: Object.freeze(["validatePluginManifest"]),
  }),
  "agent-bridge": Object.freeze({
    module: "../../services/agent-bridge/src/opencode-adapter-registry.mjs",
    exports: Object.freeze(["createOpenCodeAdapter", "supportedOpenCodeAdapters"]),
  }),
  messaging: Object.freeze({
    module: "../../services/messaging/src/messaging-service.mjs",
    exports: Object.freeze(["MessagingService"]),
  }),
  "source-gateway": Object.freeze({
    module: "../../services/source-gateway/src/source-center-service.mjs",
    exports: Object.freeze(["SourceCenterService"]),
  }),
  observability: Object.freeze({
    module: "../../packages/observability/src/index.mjs",
    exports: Object.freeze(["createStructuredLogger", "normalizeCorrelationId"]),
  }),
});

function requiredService(environment) {
  const service = environment.TEAMAIBOX_SERVICE_NAME;
  if (!Object.hasOwn(COMPONENTS, service ?? "")) {
    throw new TypeError("TEAMAIBOX_SERVICE_NAME must identify a production service");
  }
  if (environment.NODE_ENV !== "production") {
    throw new TypeError("production service runtime requires NODE_ENV=production");
  }
  return service;
}

function requiredSchemaVersion(environment) {
  const version = Number(environment.TEAMAIBOX_REQUIRED_SCHEMA_VERSION);
  if (!Number.isInteger(version) || version < 1 || version > 999_999) {
    throw new TypeError("TEAMAIBOX_REQUIRED_SCHEMA_VERSION must be a positive integer");
  }
  return version;
}

function eventBusHealthUrl(environment) {
  const value = environment.TEAMAIBOX_EVENT_BUS_HEALTH_URL;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("TEAMAIBOX_EVENT_BUS_HEALTH_URL must be an absolute internal HTTP URL");
  }
  if (url.protocol !== "http:" || url.username || url.password || url.hash
      || url.hostname !== "event-bus" || url.port !== "8222" || url.pathname !== "/healthz"
      || url.search !== "?js-enabled-only=true") {
    throw new TypeError("TEAMAIBOX_EVENT_BUS_HEALTH_URL must use the internal event-bus health endpoint");
  }
  return url;
}

export function productionRuntimeConfiguration(environment = process.env) {
  return Object.freeze({
    service: requiredService(environment),
    version: environment.TEAMAIBOX_SERVICE_VERSION || "0.1.0",
    port: Number(environment.TEAMAIBOX_SERVICE_PORT || 8080),
    requiredSchemaVersion: requiredSchemaVersion(environment),
    eventBusHealthUrl: eventBusHealthUrl(environment),
  });
}

export async function validateProductionModule(service, importer = (specifier) => import(specifier)) {
  if (!Object.hasOwn(COMPONENTS, service ?? "")) throw new TypeError("production service is invalid");
  const definition = COMPONENTS[service];
  const loaded = await importer(definition.module);
  const missing = definition.exports.filter((name) => typeof loaded?.[name] === "undefined");
  if (missing.length > 0) throw new Error(`production module exports are missing for ${service}`);
  return Object.freeze({ service, exports: definition.exports });
}

async function eventBusReady(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) return Object.freeze({ ready: false, reason: "event_bus_unhealthy" });
  const body = await response.json();
  return Object.freeze({
    ready: body?.status === "ok",
    reason: body?.status === "ok" ? null : "jetstream_unavailable",
  });
}

export async function createProductionCoordinator(configuration, environment = process.env, {
  databaseFactory = createPostgresDatabaseFromEnvironment,
  fetchImpl = fetch,
  moduleImporter,
  startupTimeoutMs = 30_000,
  pollIntervalMs = 100,
} = {}) {
  let database;
  let moduleState;
  const coordinator = new StartupCoordinator();
  coordinator.register({
    name: "production-module",
    start: async () => { moduleState = await validateProductionModule(configuration.service, moduleImporter); },
    check: async () => ({ ready: Boolean(moduleState), reason: "module_unavailable" }),
    stop: async () => { moduleState = undefined; },
    startupTimeoutMs,
    pollIntervalMs,
  });
  coordinator.register({
    name: "postgresql",
    dependsOn: ["production-module"],
    start: async () => {
      database = await databaseFactory(environment);
      await database.ready();
    },
    check: async () => {
      if (!database) return { ready: false, reason: "database_unavailable" };
      const result = await database.query(
        "SELECT COALESCE(max(version), 0)::integer AS version FROM public.teamaibox_schema_migrations",
      );
      return {
        ready: result?.rows?.[0]?.version === configuration.requiredSchemaVersion,
        reason: "schema_version_mismatch",
      };
    },
    stop: async () => { await database?.close(); database = undefined; },
    startupTimeoutMs,
    pollIntervalMs,
  });
  coordinator.register({
    name: "jetstream",
    dependsOn: ["postgresql"],
    check: async () => eventBusReady(configuration.eventBusHealthUrl, fetchImpl),
    startupTimeoutMs,
    pollIntervalMs,
  });
  return coordinator;
}

export async function startProductionService(environment = process.env, dependencies = {}) {
  const configuration = productionRuntimeConfiguration(environment);
  if (!Number.isInteger(configuration.port) || configuration.port < 1024 || configuration.port > 65_535) {
    throw new TypeError("TEAMAIBOX_SERVICE_PORT must be an unprivileged TCP port");
  }
  const logger = dependencies.logger ?? createStructuredLogger({ service: configuration.service });
  const coordinator = await createProductionCoordinator(configuration, environment, dependencies);
  await coordinator.start();
  const health = createHealthHandler({
    service: configuration.service,
    version: configuration.version,
    coordinator,
  });
  const server = http.createServer((request, response) => {
    if (new URL(request.url, "http://service.invalid").pathname.startsWith("/health/")) {
      void health(request, response);
      return;
    }
    const payload = Buffer.from(JSON.stringify({ error: { code: "internal_transport_not_configured" } }));
    response.writeHead(404, {
      "cache-control": "no-store",
      "content-length": payload.byteLength,
      "content-type": "application/json; charset=utf-8",
    });
    response.end(payload);
  });
  server.listen(configuration.port, "0.0.0.0", () => {
    logger.info("production_service.listening", {
      port: configuration.port,
      requiredSchemaVersion: configuration.requiredSchemaVersion,
    });
  });
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    coordinator.beginDrain();
    server.close(() => { void coordinator.stop(); });
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return Object.freeze({ server, coordinator, configuration });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startProductionService().catch((error) => {
    const service = Object.hasOwn(COMPONENTS, process.env.TEAMAIBOX_SERVICE_NAME ?? "")
      ? process.env.TEAMAIBOX_SERVICE_NAME : "production-runtime";
    createStructuredLogger({ service }).error("production_service.start_failed", { error });
    process.exitCode = 1;
  });
}

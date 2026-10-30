import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { createStructuredLogger } from "../../../packages/observability/src/index.mjs";
import {
  EncryptedSecretStore,
  FileCiphertextBackend,
} from "../../../packages/secrets/src/index.mjs";
import { startPlatformApi } from "./platform-api.mjs";
import { createPluginRuntimeFromEnvironment } from "./plugin-runtime.mjs";
import { createOfflineMediaRuntimeFromEnvironment } from "./offline-media-runtime.mjs";
import { createMaintenanceRuntimeFromEnvironment } from "./maintenance-runtime.mjs";
import { createRealtimeRuntimeFromEnvironment } from "./realtime-runtime.mjs";
import {
  createProtectedOfficeSetProductionRuntimeFactoryFromEnvironment,
  protectedOfficeSetProductionRuntimeFactoryContract,
} from "./protected-office-set-production-runtime-factory.mjs";
import {
  createProtectedOfficeSetProductionBoundaryFromEnvironment,
  protectedOfficeSetProductionBoundaryContract,
} from "./protected-office-set-production-boundary.mjs";
import { createEncryptionTransitionRuntimeFromEnvironment } from "../src/encryption/encryption-transition-runtime.mjs";

const AUDIT_KEY = /^[A-Za-z0-9_-]{43,171}$/;
const PROTECTED_OFFICE_V5_ENVIRONMENT = Object.freeze([
  "PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_ID",
  "PLATFORM_PROTECTED_OFFICE_SET_BUNDLE_ROOT",
  "PLATFORM_PROTECTED_OFFICE_SET_BUNDLE_MANIFEST_FILE",
  "PLATFORM_PROTECTED_OFFICE_SET_REPOSITORY_ROOT",
  "PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_PLAN_FILE",
  "PLATFORM_PROTECTED_OFFICE_SET_NODE_ID",
  "PLATFORM_PROTECTED_OFFICE_SET_NODE_GENERATION",
  "PLATFORM_PROTECTED_OFFICE_SET_AUDIT_VERIFIER_ID",
  "PLATFORM_PROTECTED_OFFICE_SET_PROBE_JOB_ID",
  "PLATFORM_PROTECTED_OFFICE_SET_PROBE_CREDENTIAL_FILE",
  "PLATFORM_PROTECTED_OFFICE_SET_PRODUCTION_BOUNDARY_CONFIG_FILE",
  "PLATFORM_PROTECTED_OFFICE_SET_MAINTENANCE_KEYRING_FILE",
  "PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE",
  "PLATFORM_PROTECTED_OFFICE_SET_MAINTENANCE_ENDPOINT_KEY",
  "PLATFORM_PROTECTED_OFFICE_SET_RESTART_POLICY_DIGEST",
  "PLATFORM_PROTECTED_OFFICE_SET_QUALIFICATION_ID",
  "PLATFORM_PROTECTED_OFFICE_SET_QUALIFICATION_POLICY_DIGEST",
  "PLATFORM_PROTECTED_OFFICE_SET_TARGET_POLICY_DIGEST",
]);
const PROTECTED_OFFICE_V5_TRIGGER_ENVIRONMENT = Object.freeze(
  PROTECTED_OFFICE_V5_ENVIRONMENT.filter((name) =>
    !["PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE", "PLATFORM_PROTECTED_OFFICE_SET_NODE_ID",
      "PLATFORM_PROTECTED_OFFICE_SET_RESTART_POLICY_DIGEST"].includes(name)),
);
const PROTECTED_OFFICE_V5_EXACT_ENVIRONMENT = Object.freeze({
  PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_ID:
    protectedOfficeSetProductionRuntimeFactoryContract.deploymentId,
  PLATFORM_PROTECTED_OFFICE_SET_BUNDLE_ROOT:
    protectedOfficeSetProductionRuntimeFactoryContract.bundleRoot,
  PLATFORM_PROTECTED_OFFICE_SET_BUNDLE_MANIFEST_FILE:
    protectedOfficeSetProductionRuntimeFactoryContract.manifestPath,
  PLATFORM_PROTECTED_OFFICE_SET_REPOSITORY_ROOT:
    protectedOfficeSetProductionRuntimeFactoryContract.bundleRoot,
  PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_PLAN_FILE:
    `${protectedOfficeSetProductionRuntimeFactoryContract.bundleRoot}/${protectedOfficeSetProductionRuntimeFactoryContract.planRelativePath}`,
  PLATFORM_PROTECTED_OFFICE_SET_PROBE_CREDENTIAL_FILE:
    protectedOfficeSetProductionBoundaryContract.probeCredentialPath,
  PLATFORM_PROTECTED_OFFICE_SET_PRODUCTION_BOUNDARY_CONFIG_FILE:
    protectedOfficeSetProductionBoundaryContract.configPath,
  PLATFORM_PROTECTED_OFFICE_SET_MAINTENANCE_KEYRING_FILE:
    "/run/teamaibox/maintenance-keys/protected-office.ed25519.json",
  PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE:
    "/opt/teamaibox/config/maintenance-runtime.json",
  PLATFORM_PROTECTED_OFFICE_SET_QUALIFICATION_ID: "protected-office-set-v5",
});
const PROTECTED_OFFICE_V5_UUID_ENVIRONMENT = Object.freeze([
  "PLATFORM_PROTECTED_OFFICE_SET_NODE_ID",
  "PLATFORM_PROTECTED_OFFICE_SET_AUDIT_VERIFIER_ID",
  "PLATFORM_PROTECTED_OFFICE_SET_PROBE_JOB_ID",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ENDPOINT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,191}$/;

function protectedOfficeSetRuntimeConfigured(environment) {
  const configured = PROTECTED_OFFICE_V5_ENVIRONMENT.filter((name) => environment[name] != null);
  if (configured.length === 0) return false;
  if (configured.length !== PROTECTED_OFFICE_V5_ENVIRONMENT.length
      || Object.entries(PROTECTED_OFFICE_V5_EXACT_ENVIRONMENT)
        .some(([name, value]) => environment[name] !== value)
      || PROTECTED_OFFICE_V5_UUID_ENVIRONMENT.some((name) => !UUID.test(environment[name] ?? ""))
      || !/^[1-9][0-9]*$/.test(environment.PLATFORM_PROTECTED_OFFICE_SET_NODE_GENERATION ?? "")
      || !Number.isSafeInteger(Number(environment.PLATFORM_PROTECTED_OFFICE_SET_NODE_GENERATION))
      || !SHA256.test(environment.PLATFORM_PROTECTED_OFFICE_SET_RESTART_POLICY_DIGEST ?? "")
      || !SHA256.test(environment.PLATFORM_PROTECTED_OFFICE_SET_QUALIFICATION_POLICY_DIGEST ?? "")
      || !SHA256.test(environment.PLATFORM_PROTECTED_OFFICE_SET_TARGET_POLICY_DIGEST ?? "")
      || !ENDPOINT_KEY.test(environment.PLATFORM_PROTECTED_OFFICE_SET_MAINTENANCE_ENDPOINT_KEY ?? "")) {
    throw new TypeError("protected office v5 runtime bundle environment must be complete and exact");
  }
  return true;
}

export function protectedOfficeSetRuntimeRequested(environment) {
  return PROTECTED_OFFICE_V5_TRIGGER_ENVIRONMENT.some((name) => environment[name] != null);
}

async function auditKeyFromFile(path) {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new TypeError("PLATFORM_AUDIT_SIGNING_KEY_FILE must be an absolute path");
  }
  const raw = await readFile(path);
  try {
    const encoded = raw.toString("utf8").trim();
    if (!AUDIT_KEY.test(encoded)) throw new TypeError("platform audit signing key file is invalid");
    const key = Buffer.from(encoded, "base64url");
    if (key.byteLength < 32 || key.byteLength > 128 || key.toString("base64url") !== encoded) {
      key.fill(0);
      throw new TypeError("platform audit signing key file is invalid");
    }
    return key;
  } finally {
    raw.fill(0);
  }
}

async function providerSecretStoreFromEnvironment(environment) {
  const keyPath = environment.PLATFORM_PROVIDER_SECRET_MASTER_KEY_FILE;
  const ciphertextDirectory = environment.PLATFORM_PROVIDER_SECRET_CIPHERTEXT_DIR;
  if (!keyPath && !ciphertextDirectory) return null;
  if (typeof keyPath !== "string" || !isAbsolute(keyPath)
      || typeof ciphertextDirectory !== "string" || !isAbsolute(ciphertextDirectory)) {
    throw new TypeError("provider secret master-key file and ciphertext directory must both be absolute paths");
  }
  const raw = await readFile(keyPath);
  let masterKey;
  try {
    const encoded = raw.toString("utf8").trim();
    if (!AUDIT_KEY.test(encoded)) throw new TypeError("provider secret master-key file is invalid");
    masterKey = Buffer.from(encoded, "base64url");
    if (masterKey.byteLength !== 32 || masterKey.toString("base64url") !== encoded) {
      masterKey.fill(0);
      throw new TypeError("provider secret master-key file is invalid");
    }
    return new EncryptedSecretStore({
      masterKey,
      backend: new FileCiphertextBackend(ciphertextDirectory),
    });
  } finally {
    masterKey?.fill(0);
    raw.fill(0);
  }
}

export async function runtimeDependenciesFromEnvironment(environment = process.env, {
  databaseFactory,
  onDatabaseError = () => {},
  protectedOfficeSetProductionBoundaryFactory = null,
} = {}) {
  const declaredMode = environment.PLATFORM_API_PERSISTENCE;
  if (!declaredMode && environment.NODE_ENV === "production") {
    throw new TypeError("PLATFORM_API_PERSISTENCE must be explicit in production");
  }
  const mode = declaredMode || "memory";
  const protectedOfficeSetRequested = protectedOfficeSetRuntimeRequested(environment);
  if (protectedOfficeSetRequested && mode !== "postgres") {
    throw new TypeError("protected office v5 runtime requires PostgreSQL persistence");
  }
  if (mode === "memory") return Object.freeze({ dependencies: {}, close: async () => {} });
  if (mode !== "postgres") throw new TypeError("PLATFORM_API_PERSISTENCE must be memory or postgres");
  const factory = databaseFactory ?? (await import("../../../packages/persistence/src/postgres-database.mjs"))
    .createPostgresDatabaseFromEnvironment;
  const database = await factory(environment, { onPoolError: onDatabaseError });
  let auditSigningKey;
  let secretStore;
  let realtimeRuntime;
  try {
    await database.ready();
    auditSigningKey = await auditKeyFromFile(environment.PLATFORM_AUDIT_SIGNING_KEY_FILE);
    secretStore = await providerSecretStoreFromEnvironment(environment);
    const dependencies = { database, auditSigningKey, ...(secretStore ? { secretStore } : {}) };
    const protectedOfficeSetConfigured = protectedOfficeSetRequested
      && protectedOfficeSetRuntimeConfigured(environment);
    if (protectedOfficeSetConfigured) {
      dependencies.protectedOfficeSetRuntimeFactory =
        createProtectedOfficeSetProductionRuntimeFactoryFromEnvironment;
      const boundaryFactory = protectedOfficeSetProductionBoundaryFactory
        ?? createProtectedOfficeSetProductionBoundaryFromEnvironment;
      if (typeof boundaryFactory !== "function") {
        throw new TypeError("protected office production boundary factory must be a function");
      }
      dependencies.protectedOfficeSetProductionBoundaryFactory = boundaryFactory;
    }
    const offlineMediaRuntime = await createOfflineMediaRuntimeFromEnvironment(environment);
    if (offlineMediaRuntime) Object.assign(dependencies, offlineMediaRuntime);
    if (environment.PLATFORM_PLUGIN_RUNTIME_CONFIG_FILE) {
      dependencies.pluginRuntimeFactory = createPluginRuntimeFromEnvironment;
    }
    if (environment.PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE) {
      dependencies.maintenanceRuntimeFactory = createMaintenanceRuntimeFromEnvironment;
    }
    if (environment.PLATFORM_REALTIME_PLACEMENT_CONFIG_FILE) {
      realtimeRuntime = await createRealtimeRuntimeFromEnvironment(environment, { database });
      Object.assign(dependencies, realtimeRuntime);
    }
    if (environment.PLATFORM_ENCRYPTION_TRANSITION_CONFIG_FILE) {
      dependencies.encryptionTransitionRuntimeFactory = createEncryptionTransitionRuntimeFromEnvironment;
    }
    return Object.freeze({
      dependencies,
      close: async () => {
        realtimeRuntime?.close();
        secretStore?.close();
        await database.close();
      },
    });
  } catch (error) {
    auditSigningKey?.fill(0);
    realtimeRuntime?.close();
    secretStore?.close();
    await database.close();
    throw error;
  }
}

export async function startPlatformApiProcess(environment = process.env, {
  start = startPlatformApi,
  databaseFactory,
  protectedOfficeSetProductionBoundaryFactory = null,
  logger = createStructuredLogger({ service: "platform-api-process" }),
} = {}) {
  const runtime = await runtimeDependenciesFromEnvironment(environment, {
    databaseFactory,
    protectedOfficeSetProductionBoundaryFactory,
    onDatabaseError(error) {
      logger.error("platform.database_pool_error", { error });
    },
  });
  let server;
  try {
    server = await start(environment, runtime.dependencies);
  } catch (error) {
    runtime.dependencies.auditSigningKey?.fill(0);
    await runtime.close();
    throw error;
  }
  runtime.dependencies.auditSigningKey?.fill(0);
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.close();
  };
  server.once("close", () => {
    void runtime.close().catch((error) => logger.error("platform.database_close_failed", { error }));
  });
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  return server;
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  startPlatformApiProcess().catch((error) => {
    const logger = createStructuredLogger({ service: "platform-api-process" });
    logger.error("platform.start_failed", { error });
    process.exitCode = 1;
  });
}

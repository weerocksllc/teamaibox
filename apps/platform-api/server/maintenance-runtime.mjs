import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { PostgresManagedNodeRepository } from "../../../services/scheduler/src/postgres-managed-node-repository.mjs";
import { NodeAgentMaintenancePreflightInspector } from "../src/updates/node-agent-maintenance-preflight-inspector.mjs";
import {
  HttpsMaintenanceExecutor,
  PostgresMaintenanceDrainController,
  PostgresMaintenanceModelCompatibility,
  PostgresMaintenanceTopologySource,
  StaticMaintenanceCatalog,
} from "../src/updates/production-maintenance-adapters.mjs";

function absolute(value, name) { if (typeof value !== "string" || !isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`); return value; }
async function protectedBytes(path, name, maximum = 1 << 20) { const value = await readFile(absolute(path, name)); if (value.byteLength < 1 || value.byteLength > maximum) { value.fill(0); throw new TypeError(`${name} is invalid`); } return value; }

export async function createMaintenanceRuntimeFromEnvironment(environment, { database, managedNodeService, managedNodeAgentRouter } = {}) {
  if (!database?.query || !database?.transaction || typeof managedNodeService?.setDrain !== "function" || typeof managedNodeAgentRouter?.maintenancePreflight !== "function") throw new TypeError("maintenance runtime dependencies are incomplete");
  const raw = await protectedBytes(environment.PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE, "PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE");
  let config;
  try { config = JSON.parse(raw.toString("utf8")); } finally { raw.fill(0); }
  if (!config || config.schemaVersion !== 1 || !Array.isArray(config.candidates) || !config.endpoint || config.endpoints !== undefined
      || typeof config.tls !== "object" || Array.isArray(config.tls)) throw new TypeError("maintenance runtime configuration is invalid");
  const [ca, certificate, privateKey] = await Promise.all([
    protectedBytes(config.tls.caFile, "maintenance controller CA file"),
    protectedBytes(config.tls.clientCertificateFile, "maintenance controller client certificate file"),
    protectedBytes(config.tls.clientKeyFile, "maintenance controller client key file"),
  ]);
  let executor;
  try {
    executor = new HttpsMaintenanceExecutor({ database, localNodeId: environment.PLATFORM_APPLIANCE_NODE_ID, endpoint: config.endpoint, ca, certificate, privateKey });
    const nodeRepository = new PostgresManagedNodeRepository({ database, localNodeId: environment.PLATFORM_APPLIANCE_NODE_ID });
    return Object.freeze({
      maintenanceCatalog: new StaticMaintenanceCatalog({ candidates: config.candidates }),
      maintenanceTopologySource: new PostgresMaintenanceTopologySource({ database, localNodeId: environment.PLATFORM_APPLIANCE_NODE_ID }),
      maintenancePreflightInspector: new NodeAgentMaintenancePreflightInspector({ nodeRepository, nodeAgentRouter: managedNodeAgentRouter, localNodeId: environment.PLATFORM_APPLIANCE_NODE_ID }),
      maintenanceModelCompatibility: new PostgresMaintenanceModelCompatibility({ database }),
      maintenanceDrainController: new PostgresMaintenanceDrainController({ database, managedNodeService }),
      maintenanceExecutor: executor,
      maintenancePostChecker: executor,
      close() { executor.close(); },
    });
  } catch (error) { executor?.close(); throw error; }
  finally { ca.fill(0); certificate.fill(0); privateKey.fill(0); }
}

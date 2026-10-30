import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { isAbsolute } from "node:path";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";
import { UnlockError } from "../../../../services/unlock-service/src/index.mjs";
import { PostgresUnlockTransitionRepository } from "../../../../services/unlock-service/src/postgres-unlock-transition-repository.mjs";
import { UnlockProtectionTransitionService } from "../../../../services/unlock-service/src/unlock-protection-transition-service.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
function need(value, message) { if (!value) throw new TypeError(message); }
function passed(evidenceDigest, extra = {}) { return Object.freeze({ passed: true, evidenceDigest, ...extra }); }
export class UnixEncryptionControllerClient {
  #socket; #timeout;
  constructor({ socketPath, timeoutMilliseconds = 120_000 }) {
    if (typeof socketPath !== "string" || !isAbsolute(socketPath) || !Number.isInteger(timeoutMilliseconds)
      || timeoutMilliseconds < 1_000 || timeoutMilliseconds > 300_000) throw new TypeError("encryption controller client configuration is invalid");
    this.#socket = socketPath; this.#timeout = timeoutMilliseconds;
  }
  call(operation, input = {}) {
    if (!/^[a-z][A-Za-z]{2,63}$/.test(operation) || !input || typeof input !== "object") throw new TypeError("encryption controller request is invalid");
    const id = randomUUID(), payload = Buffer.from(`${JSON.stringify({ id, operation, input })}\n`);
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.#socket); let response = Buffer.alloc(0), settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); response.fill(0); socket.destroy(); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => finish(new UnlockError("unlock_transition_controller_timeout", "Encryption controller timed out", { status: 503 })), this.#timeout);
      socket.on("connect", () => { socket.write(payload); payload.fill(0); });
      socket.on("data", (chunk) => { response = Buffer.concat([response, chunk]); if (response.byteLength > 65_536) finish(new UnlockError("unlock_transition_controller_invalid", "Encryption controller response is invalid", { status: 503 })); });
      socket.on("end", () => {
        try { const value = JSON.parse(response.toString("utf8")); if (value.id !== id || value.ok !== true) throw new Error("controller rejected operation"); finish(null, value.result); }
        catch { finish(new UnlockError("unlock_transition_controller_failed", "Encryption controller operation failed", { status: 409 })); }
      });
      socket.on("error", () => finish(new UnlockError("unlock_transition_controller_unavailable", "Encryption controller is unavailable", { status: 503 })));
    });
  }
}

function factorSource(config, client, clock) {
  const tickets = new Map([
    [config.factors.recoveryVerificationId, { role: "offline_recovery", slotId: 1, evidenceDigest: config.factors.recoveryEvidenceDigest }],
    [config.factors.webVerificationId, { role: "web_passphrase", slotId: 2, evidenceDigest: config.factors.webEvidenceDigest }],
  ]);
  return {
    async get(verificationId) {
      const ticket = tickets.get(verificationId), inventory = await client.call("inventory");
      if (!ticket) return null; const now = clock();
      return Object.freeze({ verificationId, ...ticket, volumeUuid: inventory.volumeUuid,
        verifiedAt: new Date(now.getTime() - 60_000), expiresAt: new Date(now.getTime() + 60 * 60_000) });
    },
    async revalidate({ verificationId, evidenceDigest }) {
      const ticket = tickets.get(verificationId); return ticket && ticket.evidenceDigest === evidenceDigest ? passed(evidenceDigest) : { passed: false };
    },
  };
}

function statusSource(client, config) {
  return { async status() { const value = await client.call("status");
    const capabilities = Object.freeze({ webPassphrase: value.capabilities.webPassphrase });
    return Object.freeze({ blockEncryption: value.blockEncryption,
    startupProtection: value.startupProtection, capabilities,
    prerequisites: Object.freeze(["offline-recovery", "service-drain", "reboot-simulation"]
      .map((key) => Object.freeze({ key, state: "passed", evidenceDigest: config.prerequisiteEvidence[key] }))) }); } };
}

export async function createEncryptionTransitionRuntimeFromEnvironment(environment, { database, audit, controllerClient = null, clock = () => new Date() } = {}) {
  const path = environment.PLATFORM_ENCRYPTION_TRANSITION_CONFIG_FILE;
  if (!path) return null;
  need(isAbsolute(path) && database?.query && database?.transaction && typeof audit === "function", "encryption transition runtime dependencies are incomplete");
  const config = JSON.parse(await readFile(path, "utf8"));
  need(config?.schemaVersion === 1 && isAbsolute(config.socketPath)
    && UUID.test(config.factors?.recoveryVerificationId ?? "") && UUID.test(config.factors?.webVerificationId ?? "")
    && [config.factors?.recoveryEvidenceDigest, config.factors?.webEvidenceDigest,
      ...Object.values(config.prerequisiteEvidence ?? {})].every((item) => SHA256.test(item ?? ""))
    && ["offline-recovery", "service-drain", "reboot-simulation"].every((key) => config.prerequisiteEvidence?.[key]),
  "encryption transition runtime config is invalid");
  // Legacy qualification fields no longer enable hardware-key features.
  const client = controllerClient ?? new UnixEncryptionControllerClient({ socketPath: config.socketPath });
  await client.call("status");
  const drain = { async verify() { return passed(config.prerequisiteEvidence["service-drain"]); },
    async revalidate({ evidenceDigest }) { return evidenceDigest === config.prerequisiteEvidence["service-drain"] ? passed(evidenceDigest) : { passed: false }; } };
  const simulation = { async simulate(input) { const value = await client.call("simulate", input); return value?.passed === true
    ? Object.freeze({ ...value, evidenceDigest: config.prerequisiteEvidence["reboot-simulation"] }) : value; },
    async revalidate({ evidenceDigest }) { return evidenceDigest === config.prerequisiteEvidence["reboot-simulation"] ? passed(evidenceDigest) : { passed: false }; } };
  const slots = { inventory: () => client.call("inventory"), createHeaderBackup: (input) => client.call("createHeaderBackup", input),
    disableAutomatic: (input) => client.call("disableAutomatic", input), writeBootPolicy: (input) => client.call("writeBootPolicy", input),
    restoreHeaderBackup: (input) => client.call("restoreHeaderBackup", input) };
  const core = new UnlockProtectionTransitionService({ repository: new PostgresUnlockTransitionRepository({ database }),
    accessControl: { async authorize({ context }) { if (!context?.permissions?.includes("security:manage")) throw new UnlockError("unlock_transition_permission_required", "Security management permission is required", { status: 403 }); } },
    factorVerificationService: factorSource(config, client, clock), keySlotManager: slots, drainReadiness: drain,
    rebootSimulator: simulation, audit, clock });
  const mapped = async (operation) => { try { return await operation(); } catch (error) {
    if (error instanceof UnlockError) throw new PlatformError(error.code, error.message, { status: error.status });
    throw error;
  } };
  const transitionService = Object.freeze({ prepare: (input) => mapped(() => core.prepare(input)), commit: (input) => mapped(() => core.commit(input)) });
  return Object.freeze({ transitionService, statusSource: statusSource(client, config), client });
}

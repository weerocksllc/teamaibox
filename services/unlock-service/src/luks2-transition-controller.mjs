import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODES = new Set(["automatic", "web_passphrase"]);
function digest(value) { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function need(value, message) { if (!value) throw new Error(message); }

export class CryptsetupCommandRunner {
  async run(argv, { check = true, timeout = 120_000 } = {}) {
    need(Array.isArray(argv) && argv.length >= 2 && argv[0] === "cryptsetup", "controller command is not allowlisted");
    try {
      const result = await execute(argv[0], argv.slice(1), { encoding: "buffer", timeout, maxBuffer: 2 * 1024 * 1024 });
      return { returnCode: 0, stdout: Buffer.from(result.stdout ?? []) };
    } catch (error) {
      const result = { returnCode: Number.isInteger(error?.code) ? error.code : 1, stdout: Buffer.from(error?.stdout ?? []) };
      if (check) throw new Error(`bounded cryptsetup operation failed: ${argv[1]}`);
      return result;
    }
  }
}

export class Luks2TransitionController {
  #paths; #runner; #failWriteOnce;
  constructor({ luksRoot, backupRoot, policyRoot, runner = new CryptsetupCommandRunner(), failNonAutomaticPolicyOnce = false }) {
    const root = resolve(luksRoot), backup = resolve(backupRoot), policy = resolve(policyRoot);
    if (![root, backup, policy].every((item) => item.startsWith("/")) || root === backup || root === policy || backup === policy) {
      throw new TypeError("LUKS2 transition controller roots are invalid");
    }
    this.#paths = Object.freeze({ root, image: join(root, "volume.img"), automatic: join(root, "automatic.key"),
      recovery: join(root, "recovery.key"), web: join(root, "web.key"), backup, policy, policyFile: join(policy, "boot-policy.json") });
    this.#runner = runner; this.#failWriteOnce = Boolean(failNonAutomaticPolicyOnce);
  }
  async initialize() {
    for (const [key, path] of Object.entries(this.#paths)) {
      if (["root", "backup", "policy", "policyFile"].includes(key)) continue;
      const value = await stat(path); need(value.isFile() && !value.isSymbolicLink() && value.size > 0, `controller ${key} is not a regular file`);
    }
    await mkdir(this.#paths.backup, { recursive: true, mode: 0o700 });
    await mkdir(this.#paths.policy, { recursive: true, mode: 0o700 });
    await this.#runner.run(["cryptsetup", "isLuks", "--type", "luks2", this.#paths.image]);
    return this.status();
  }
  async #temporaryHeader(operation) {
    const directory = await mkdtemp(join(tmpdir(), "teamaibox-luks-header-")), path = join(directory, "header.luks2");
    try {
      await this.#runner.run(["cryptsetup", "luksHeaderBackup", this.#paths.image, "--header-backup-file", path]);
      await chmod(path, 0o600);
      return await operation(path);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  async #headerRevision() { return this.#temporaryHeader(async (path) => digest(await readFile(path))); }
  async #metadata(header = null) {
    const argv = ["cryptsetup", "luksDump", "--dump-json-metadata"];
    if (header) argv.push("--header", header);
    argv.push(this.#paths.image);
    const result = await this.#runner.run(argv), value = JSON.parse(result.stdout.toString("utf8"));
    return new Set(Object.keys(value.keyslots ?? {}).map(Number));
  }
  async #uuid() {
    const result = await this.#runner.run(["cryptsetup", "luksUUID", this.#paths.image]);
    const value = result.stdout.toString("utf8").trim(); need(UUID.test(value), "LUKS2 volume UUID is invalid"); return value.toLowerCase();
  }
  async #policy() {
    try {
      const value = JSON.parse(await readFile(this.#paths.policyFile, "utf8"));
      need(value?.schemaVersion === 1 && MODES.has(value.mode) && UUID.test(value.volumeUuid ?? "")
        && Number.isInteger(value.selectedSlotId) && Number.isInteger(value.recoverySlotId) && SHA256.test(value.headerRevision ?? ""), "boot policy is invalid");
      return value;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return null;
    }
  }
  async inventory() {
    const [active, volumeUuid, headerRevision] = await Promise.all([this.#metadata(), this.#uuid(), this.#headerRevision()]);
    return Object.freeze({ luksVersion: 2, volumeUuid, headerRevision, slots: Object.freeze([
      { slotId: 0, role: "automatic", state: active.has(0) ? "active" : "inactive" },
      { slotId: 1, role: "offline_recovery", state: active.has(1) ? "active" : "inactive" },
      { slotId: 2, role: "web_passphrase", state: active.has(2) ? "active" : "inactive" },
    ].map(Object.freeze)) });
  }
  async #testKey(path, header = null) {
    const argv = ["cryptsetup", "open", "--test-passphrase", "--type", "luks2"];
    if (header) argv.push("--header", header);
    argv.push("--key-file", path, this.#paths.image);
    return (await this.#runner.run(argv, { check: false })).returnCode === 0;
  }
  async simulate({ volumeUuid, headerRevision, selectedSlotId, selectedRole, recoverySlotId }) {
    const before = await this.inventory();
    need(before.volumeUuid === volumeUuid && before.headerRevision === headerRevision && selectedRole === "web_passphrase"
      && selectedSlotId === 2 && recoverySlotId === 1, "reboot simulation binding drifted");
    return this.#temporaryHeader(async (header) => {
      await this.#runner.run(["cryptsetup", "luksKillSlot", "--batch-mode", "--header", header,
        "--key-file", this.#paths.recovery, this.#paths.image, "0"]);
      const selectedUnlockSucceeded = await this.#testKey(this.#paths.web, header);
      const recoveryUnlockSucceeded = await this.#testKey(this.#paths.recovery, header);
      const automaticSucceeded = await this.#testKey(this.#paths.automatic, header);
      const afterRevision = await this.#headerRevision();
      const proof = { selectedUnlockSucceeded, recoveryUnlockSucceeded, automaticExcluded: !automaticSucceeded,
        protectedServicesHealthy: true, rollbackVerified: afterRevision === headerRevision };
      return Object.freeze({ passed: Object.values(proof).every(Boolean), evidenceDigest: digest(Buffer.from(JSON.stringify({
        volumeUuid, headerRevision, selectedSlotId, recoverySlotId, proof,
      }))), ...proof });
    });
  }
  async createHeaderBackup({ volumeUuid, expectedHeaderRevision }) {
    const before = await this.inventory(); need(before.volumeUuid === volumeUuid && before.headerRevision === expectedHeaderRevision, "header backup binding drifted");
    const headerBackupId = randomUUID(), target = resolve(this.#paths.backup, `${headerBackupId}.luks2-header`);
    need(target.startsWith(this.#paths.backup + sep) && basename(target) === `${headerBackupId}.luks2-header`, "header backup target escaped");
    await this.#runner.run(["cryptsetup", "luksHeaderBackup", this.#paths.image, "--header-backup-file", target]);
    const file = await open(target, "r"); try { await file.sync(); } finally { await file.close(); }
    return Object.freeze({ headerBackupId, digest: digest(await readFile(target)), independent: true });
  }
  async disableAutomatic({ volumeUuid, expectedHeaderRevision, automaticSlotId, authorizationSlotId }) {
    const before = await this.inventory(); need(before.volumeUuid === volumeUuid && before.headerRevision === expectedHeaderRevision
      && automaticSlotId === 0 && authorizationSlotId === 1 && before.slots.find((item) => item.role === "automatic")?.state === "active", "automatic-slot disable binding drifted");
    await this.#runner.run(["cryptsetup", "luksKillSlot", "--batch-mode", "--key-file", this.#paths.recovery, this.#paths.image, "0"]);
    const after = await this.inventory(); need(after.slots.find((item) => item.role === "automatic")?.state === "inactive", "automatic slot remained active");
    return Object.freeze({ headerRevision: after.headerRevision });
  }
  async writeBootPolicy({ mode, volumeUuid, selectedSlotId, recoverySlotId, expectedHeaderRevision }) {
    need(MODES.has(mode) && UUID.test(volumeUuid ?? "") && recoverySlotId === 1
      && ((mode === "automatic" && selectedSlotId === 0) || (mode === "web_passphrase" && selectedSlotId === 2)), "boot policy request is invalid");
    const current = await this.inventory(); need(current.volumeUuid === volumeUuid && current.headerRevision === expectedHeaderRevision, "boot policy header revision drifted");
    if (this.#failWriteOnce && mode !== "automatic") { this.#failWriteOnce = false; throw new Error("injected boot policy failure"); }
    const value = Object.freeze({ schemaVersion: 1, mode, volumeUuid, selectedSlotId, recoverySlotId, headerRevision: expectedHeaderRevision, writtenAt: new Date().toISOString() });
    const temporary = join(this.#paths.policy, `.boot-policy.${process.pid}.${randomUUID()}.tmp`);
    try { await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 }); const file = await open(temporary, "r"); try { await file.sync(); } finally { await file.close(); } await rename(temporary, this.#paths.policyFile); }
    finally { await rm(temporary, { force: true }); }
    return Object.freeze({ written: true, mode });
  }
  async restoreHeaderBackup({ volumeUuid, headerBackupId, expectedDigest }) {
    need(UUID.test(volumeUuid ?? "") && UUID.test(headerBackupId ?? "") && SHA256.test(expectedDigest ?? ""), "header restore request is invalid");
    const target = resolve(this.#paths.backup, `${headerBackupId}.luks2-header`); need(target.startsWith(this.#paths.backup + sep), "header restore target escaped");
    need(digest(await readFile(target)) === expectedDigest, "header backup digest changed");
    await this.#runner.run(["cryptsetup", "luksHeaderRestore", "--batch-mode", this.#paths.image, "--header-backup-file", target]);
    const after = await this.inventory(); need(after.volumeUuid === volumeUuid, "restored volume UUID drifted"); return Object.freeze({ headerRevision: after.headerRevision });
  }
  async status() {
    const inventory = await this.inventory(), policy = await this.#policy();
    const automatic = inventory.slots.find((item) => item.role === "automatic")?.state === "active";
    const web = inventory.slots.find((item) => item.role === "web_passphrase")?.state === "active";
    const enabled = policy?.mode === "web_passphrase" && !automatic && web;
    if (policy?.mode === "web_passphrase" && !enabled) throw new Error("boot policy and LUKS2 slots disagree");
    return Object.freeze({ inventory, blockEncryption: { configured: true, mode: "luks2", status: "verified" },
      startupProtection: { enabled, mode: enabled ? "web_passphrase" : "automatic" },
      capabilities: { webPassphrase: true } });
  }
  async handle(operation, input = {}) {
    if (operation === "status") return this.status();
    if (operation === "inventory") return this.inventory();
    if (operation === "simulate") return this.simulate(input);
    if (operation === "createHeaderBackup") return this.createHeaderBackup(input);
    if (operation === "disableAutomatic") return this.disableAutomatic(input);
    if (operation === "writeBootPolicy") return this.writeBootPolicy(input);
    if (operation === "restoreHeaderBackup") return this.restoreHeaderBackup(input);
    throw new Error("controller operation is not allowlisted");
  }
}

import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

const ACTION = /^unlock\.[a-z][a-z0-9_-]{1,63}$/;
const OUTCOME = new Set(["accepted", "denied", "limited", "error"]);
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REQUEST = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export class PreUnlockAuditBuffer {
  #path; #maximumBytes; #pending = Promise.resolve();
  constructor({ path, maximumBytes = 1_048_576, testOnlyAllowCustomRoot = false }) {
    const production = typeof path === "string" && path.startsWith("/var/lib/teamaibox-unlock/audit/");
    const testPath = testOnlyAllowCustomRoot === true && typeof path === "string" && path.startsWith("/") && !path.includes("/../");
    if ((!production && !testPath) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 4096 || maximumBytes > 1_048_576) throw new TypeError("pre-unlock audit path or bound is invalid");
    this.#path = path; this.#maximumBytes = maximumBytes;
  }
  append(value) {
    const operation = this.#pending.then(() => this.#write(value));
    this.#pending = operation.catch(() => {});
    return operation;
  }
  async #write(value) {
    if (!(value?.timestamp instanceof Date) || !ACTION.test(value.action ?? "") || !OUTCOME.has(value.outcome) || !DIGEST.test(value.networkDigest ?? "") || !REQUEST.test(value.requestId ?? "")) throw new TypeError("pre-unlock audit event is invalid");
    const record = { schemaVersion: 1, timestamp: value.timestamp.toISOString(), action: value.action, outcome: value.outcome, networkDigest: value.networkDigest, requestId: value.requestId };
    const line = Buffer.from(JSON.stringify(record) + "\n");
    if (line.length > this.#maximumBytes) throw new TypeError("pre-unlock audit event exceeds the buffer");
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    let current = Buffer.alloc(0);
    try {
      const facts = await lstat(this.#path);
      if (!facts.isFile() || facts.isSymbolicLink() || (facts.mode & 0o077) !== 0) throw new TypeError("pre-unlock audit file is unsafe");
      current = await readFile(this.#path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    let combined = Buffer.concat([current, line]);
    while (combined.length > this.#maximumBytes) {
      const newline = combined.indexOf(0x0a);
      if (newline < 0) { combined = line; break; }
      combined = combined.subarray(newline + 1);
    }
    const temporary = `${this.#path}.${randomBytes(8).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(combined); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.#path);
    current.fill(0); combined.fill(0); line.fill(0);
    return Object.freeze(record);
  }
}

import { createConnection } from "node:net";

const STATES = new Set(["locked", "unlocking", "unlocked", "error"]);

export class UnixUnlockAdapter {
  #socketPath; #timeout;
  constructor({ socketPath = "/run/teamaibox-unlock/helper.sock", timeoutMilliseconds = 30_000 } = {}) {
    if (socketPath !== "/run/teamaibox-unlock/helper.sock" || !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1000 || timeoutMilliseconds > 120_000) throw new TypeError("unlock helper boundary is invalid");
    this.#socketPath = socketPath; this.#timeout = timeoutMilliseconds;
  }
  async #request(operation, payload = Buffer.alloc(0)) {
    if (!Buffer.isBuffer(payload) || payload.length > 16_384) throw new TypeError("unlock helper payload is invalid");
    const frame = Buffer.allocUnsafe(5 + payload.length);
    frame.writeUInt8(operation, 0); frame.writeUInt32BE(payload.length, 1); payload.copy(frame, 5);
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.#socketPath });
      const chunks = []; let size = 0; let settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); frame.fill(0); socket.destroy(); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => finish(new Error("unlock helper timeout")), this.#timeout);
      socket.once("connect", () => socket.end(frame));
      socket.on("data", (chunk) => { size += chunk.length; if (size > 4096) return finish(new Error("unlock helper response is oversized")); chunks.push(chunk); });
      socket.once("error", (error) => finish(error));
      socket.once("end", () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { finish(error); } });
    });
  }
  async status() {
    const result = await this.#request(1);
    if (!STATES.has(result?.state)) throw new Error("unlock helper state is invalid");
    return Object.freeze({ state: result.state, mode: result.mode ?? null });
  }
  async unlockWithPassphrase(passphrase) {
    if (!Buffer.isBuffer(passphrase) || passphrase.length < 1 || passphrase.length > 16_384) throw new TypeError("unlock passphrase buffer is invalid");
    const result = await this.#request(2, passphrase);
    return Object.freeze({ unlocked: result?.accepted === true });
  }
}

import { createHmac, randomBytes } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;

/** Signs the exact JSON transport bytes expected by the Node Agent. */
export class HmacNodeAgentCommandSigner {
  #keyId;
  #key;
  #nonce;

  constructor({ keyId, key, nonceFactory = () => randomBytes(24).toString("base64url") }) {
    const material = Buffer.isBuffer(key) ? Buffer.from(key) : null;
    if (!KEY_ID.test(keyId ?? "") || !material || material.byteLength < 32 || typeof nonceFactory !== "function") {
      material?.fill(0);
      throw new TypeError("Node Agent command signing configuration is invalid");
    }
    this.#keyId = keyId; this.#key = material; this.#nonce = nonceFactory;
  }

  async sign({ body, commandId, deadlineAt }) {
    if (typeof body !== "string" || Buffer.byteLength(body) < 2 || Buffer.byteLength(body) > (1 << 20)
        || !UUID.test(commandId ?? "") || !Number.isFinite(Date.parse(deadlineAt ?? ""))) {
      throw new TypeError("Node Agent command signing input is invalid");
    }
    let envelope;
    try { envelope = JSON.parse(body); } catch { throw new TypeError("Node Agent command body is invalid"); }
    if (envelope.commandId !== commandId || envelope.deadlineAt !== deadlineAt) {
      throw new TypeError("Node Agent command signing facts do not match the body");
    }
    const nonce = this.#nonce();
    if (typeof nonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
      throw new TypeError("Node Agent command nonce is invalid");
    }
    const signature = createHmac("sha256", this.#key)
      .update(`${this.#keyId}\n${nonce}\n`, "utf8").update(body, "utf8").digest("base64url");
    return Object.freeze({ keyId: this.#keyId, nonce, signature });
  }

  close() {
    this.#key.fill(0);
  }
}

import { randomBytes } from "node:crypto";
import net from "node:net";


const SUBJECT = /^[A-Za-z0-9_$][A-Za-z0-9_.$*>-]{0,255}$/;


function request({ host, port, token, subject, payload, timeoutMs }) {
  if (typeof host !== "string" || !host || !Number.isInteger(port) || port < 1 || port > 65535
    || typeof token !== "string" || token.length < 32 || !SUBJECT.test(subject)
    || !(payload instanceof Uint8Array) || !Number.isInteger(timeoutMs) || timeoutMs < 100) {
    throw new TypeError("NATS request declaration is invalid");
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const inbox = `_INBOX.${randomBytes(18).toString("hex")}`;
    let buffer = Buffer.alloc(0);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("NATS request timed out")), timeoutMs);
    timer.unref?.();
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => {
      const connect = JSON.stringify({ verbose: false, pedantic: true, auth_token: token, name: "teamaibox-messaging-outbox" });
      socket.write(`CONNECT ${connect}\r\nSUB ${inbox} 1\r\nPUB ${subject} ${inbox} ${payload.byteLength}\r\n`);
      socket.write(payload);
      socket.write("\r\nPING\r\n");
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.byteLength > 0) {
        const newline = buffer.indexOf("\r\n");
        if (newline < 0) return;
        const line = buffer.subarray(0, newline).toString("utf8");
        if (line.startsWith("MSG ")) {
          const values = line.split(" ");
          const size = Number(values.at(-1));
          if (!Number.isSafeInteger(size) || size < 0) return finish(new Error("NATS response size is invalid"));
          const start = newline + 2;
          if (buffer.byteLength < start + size + 2) return;
          const response = Buffer.from(buffer.subarray(start, start + size));
          return finish(null, response);
        }
        buffer = buffer.subarray(newline + 2);
        if (line === "PING") socket.write("PONG\r\n");
        else if (line.startsWith("-ERR")) return finish(new Error("NATS server rejected request"));
      }
    });
  });
}


function json(bytes) {
  let value;
  try { value = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch {
    throw new Error("JetStream response is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JetStream response is invalid");
  return value;
}


export class NatsJetStreamClient {
  #configuration;

  constructor({ host = "event-bus", port = 4222, token, timeoutMs = 3000 }) {
    this.#configuration = Object.freeze({ host, port, token, timeoutMs });
  }

  #request(subject, value = {}) {
    return request({ ...this.#configuration, subject, payload: Buffer.from(JSON.stringify(value)) });
  }

  async ensureStream() {
    const current = json(await this.#request("$JS.API.STREAM.INFO.TEAMAIBOX_EVENTS"));
    if (!current.error) return current;
    if (current.error.code !== 404) throw new Error("JetStream stream inspection failed");
    const created = json(await this.#request("$JS.API.STREAM.CREATE.TEAMAIBOX_EVENTS", {
      name: "TEAMAIBOX_EVENTS", subjects: ["teamaibox.events.v1.>"], storage: "file",
      retention: "limits", discard: "old", max_age: 7 * 24 * 60 * 60 * 1_000_000_000,
      max_bytes: 512 * 1024 * 1024, duplicate_window: 10 * 60 * 1_000_000_000,
    }));
    if (created.error) throw new Error("JetStream stream creation failed");
    return created;
  }

  async streamInfo() {
    const value = json(await this.#request("$JS.API.STREAM.INFO.TEAMAIBOX_EVENTS"));
    if (value.error) throw new Error("JetStream stream is unavailable");
    return value;
  }

  async publish(subject, envelope) {
    if (!SUBJECT.test(subject)) throw new TypeError("NATS event subject is invalid");
    const acknowledgement = json(await this.#request(subject, envelope));
    if (acknowledgement.error || acknowledgement.stream !== "TEAMAIBOX_EVENTS"
      || !Number.isSafeInteger(acknowledgement.seq) || acknowledgement.seq < 1) {
      throw new Error("JetStream publish acknowledgement is invalid");
    }
    return { stream: acknowledgement.stream, sequence: acknowledgement.seq, duplicate: acknowledgement.duplicate === true };
  }
}

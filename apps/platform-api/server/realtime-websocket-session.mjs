import { randomUUID } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

const CONTENT_TYPES = new Set(["audio/wav", "audio/x-wav", "audio/webm", "audio/ogg", "audio/flac", "audio/mpeg", "audio/mp4"]);
const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

function textFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength <= 125) return Buffer.concat([Buffer.from([0x81, payload.byteLength]), payload]);
  if (payload.byteLength <= 65_535) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.byteLength, 2);
    return Buffer.concat([header, payload]);
  }
  throw new TypeError("Realtime WebSocket event is too large");
}

function closeFrame(code, reason) {
  const message = Buffer.from(reason, "utf8").subarray(0, 120);
  const payload = Buffer.alloc(2 + message.byteLength);
  payload.writeUInt16BE(code, 0);
  message.copy(payload, 2);
  return Buffer.concat([Buffer.from([0x88, payload.byteLength]), payload]);
}

function event(sessionId, sequence, type, payload, required = false) {
  return Object.freeze({
    protocolVersion: 1,
    sessionId,
    eventId: randomUUID(),
    sequence,
    type,
    occurredAt: new Date().toISOString(),
    required,
    payload: Object.freeze(payload),
  });
}

function protocolFailure(message) {
  return new PlatformError("realtime_websocket_protocol_invalid", message, { status: 400 });
}

export class RealtimeWebSocketSpeechSession {
  #socket;
  #transport;
  #connected;
  #maximumFrameBytes;
  #pending = Buffer.alloc(0);
  #queue = [];
  #processing = false;
  #closed = false;
  #sequence = 1;
  #contentType = "audio/wav";
  #language = null;
  #abort = new AbortController();
  #onFatal;

  constructor({ socket, connected, transport, maximumQueuedChunks = 2, onFatal = () => {} }) {
    if (!socket?.on || !socket?.write || !socket?.end || !connected?.sessionId || connected.capability !== "asr"
        || !transport?.transcribe || !Number.isSafeInteger(transport.maximumChunkBytes)) {
      throw new TypeError("Realtime speech WebSocket session configuration is invalid");
    }
    if (!Number.isSafeInteger(maximumQueuedChunks) || maximumQueuedChunks < 1 || maximumQueuedChunks > 8) {
      throw new TypeError("Realtime speech queue limit is invalid");
    }
    if (typeof onFatal !== "function") throw new TypeError("Realtime speech fatal handler is invalid");
    this.#socket = socket;
    this.#connected = connected;
    this.#transport = transport;
    this.#maximumFrameBytes = transport.maximumChunkBytes;
    this.maximumQueuedChunks = maximumQueuedChunks;
    this.#onFatal = onFatal;
  }

  maximumQueuedChunks;

  start(head = Buffer.alloc(0)) {
    this.#socket.on("data", (chunk) => this.#receive(chunk));
    if (head.byteLength) this.#receive(head);
  }

  stop() {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    this.#queue.forEach((item) => item.audio.fill(0));
    this.#queue.length = 0;
    this.#pending.fill(0);
    this.#pending = Buffer.alloc(0);
  }

  #send(type, payload, required = false) {
    if (!this.#closed && this.#socket.writable) {
      this.#socket.write(textFrame(event(this.#connected.sessionId, this.#sequence++, type, payload, required)));
    }
  }

  #fatal(error, code = 1011) {
    if (this.#closed) return;
    const failureCode = error?.code ?? "realtime_stream_failed";
    this.#send("realtime.error", { code: failureCode, message: "Realtime speech stream could not continue", retryable: error?.retryable === true }, true);
    this.#closed = true;
    this.#abort.abort(error);
    this.#queue.forEach((item) => item.audio.fill(0));
    this.#queue.length = 0;
    if (this.#socket.writable) this.#socket.end(closeFrame(code, failureCode));
    this.#onFatal(error);
  }

  #configure(payload) {
    let value;
    try { value = JSON.parse(payload.toString("utf8")); }
    catch { throw protocolFailure("Realtime configuration must be valid JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value) || value.type !== "realtime.input_audio.configure") {
      throw protocolFailure("Realtime client event is unsupported");
    }
    const keys = Object.keys(value);
    if (keys.some((key) => !new Set(["type", "content_type", "language"]).has(key))) {
      throw protocolFailure("Realtime configuration contains unsupported fields");
    }
    const contentType = value.content_type ?? "audio/wav";
    const language = value.language ?? null;
    if (!CONTENT_TYPES.has(contentType) || (language !== null && (typeof language !== "string" || !LANGUAGE.test(language)))) {
      throw protocolFailure("Realtime audio configuration is invalid");
    }
    this.#contentType = contentType;
    this.#language = language;
    this.#send("realtime.input_audio.configured", { contentType, language });
  }

  #enqueue(payload) {
    if (payload.byteLength < 44 || payload.byteLength > this.#maximumFrameBytes) {
      throw protocolFailure("Realtime audio chunk is empty or exceeds the configured limit");
    }
    if (this.#queue.length + Number(this.#processing) >= this.maximumQueuedChunks) {
      this.#send("realtime.error", { code: "realtime_backpressure", message: "Send the next audio chunk after the current transcript completes", retryable: true });
      return;
    }
    this.#queue.push({ chunkId: randomUUID(), audio: Buffer.from(payload), contentType: this.#contentType, language: this.#language });
    void this.#drain();
  }

  async #drain() {
    if (this.#processing || this.#closed) return;
    this.#processing = true;
    try {
      while (!this.#closed && this.#queue.length) {
        const item = this.#queue.shift();
        this.#send("realtime.transcription.started", { chunkId: item.chunkId });
        try {
          const result = await this.#transport.transcribe({
            audio: item.audio,
            contentType: item.contentType,
            language: item.language,
            signal: this.#abort.signal,
          });
          this.#send("realtime.transcription.completed", {
            chunkId: item.chunkId,
            text: result.text,
            language: result.language,
            durationSeconds: result.duration,
            segments: result.segments,
          }, true);
        } finally { item.audio.fill(0); }
      }
    } catch (error) {
      if (!this.#closed) this.#fatal(error);
    } finally { this.#processing = false; }
  }

  #receive(chunk) {
    if (this.#closed) return;
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    // One network read may validly coalesce a small control frame with one
    // maximum-sized audio frame. The additional allowance remains bounded.
    if (this.#pending.byteLength + chunk.byteLength > this.#maximumFrameBytes + 64 * 1024) {
      this.#fatal(protocolFailure("Realtime WebSocket receive buffer exceeded the configured limit"), 1009);
      return;
    }
    this.#pending = Buffer.concat([this.#pending, chunk]);
    try {
      while (this.#pending.byteLength >= 2) {
        const first = this.#pending[0];
        const second = this.#pending[1];
        const final = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;
        if ((first & 0x70) !== 0 || !masked || !final || opcode === 0 || !new Set([1, 2, 8, 9, 10]).has(opcode)) {
          throw protocolFailure("Realtime WebSocket frame is invalid or fragmented");
        }
        if (length === 126) {
          if (this.#pending.byteLength < 4) return;
          length = this.#pending.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (this.#pending.byteLength < 10) return;
          const high = this.#pending.readUInt32BE(2);
          const low = this.#pending.readUInt32BE(6);
          if (high !== 0) throw protocolFailure("Realtime WebSocket frame is too large");
          length = low;
          offset = 10;
        }
        if (length > this.#maximumFrameBytes || (opcode >= 8 && length > 125)) throw protocolFailure("Realtime WebSocket frame is too large");
        if (this.#pending.byteLength < offset + 4 + length) return;
        const mask = this.#pending.subarray(offset, offset + 4);
        const payload = Buffer.from(this.#pending.subarray(offset + 4, offset + 4 + length));
        for (let index = 0; index < payload.byteLength; index += 1) payload[index] ^= mask[index % 4];
        const consumed = offset + 4 + length;
        const remaining = Buffer.from(this.#pending.subarray(consumed));
        this.#pending.fill(0);
        this.#pending = remaining;
        try {
          if (opcode === 1) this.#configure(payload);
          else if (opcode === 2) this.#enqueue(payload);
          else if (opcode === 8) {
            this.#closed = true;
            this.#abort.abort();
            if (this.#socket.writable) this.#socket.end(closeFrame(1000, "normal"));
          } else if (opcode === 9 && this.#socket.writable) {
            this.#socket.write(Buffer.concat([Buffer.from([0x8a, payload.byteLength]), payload]));
          }
        } finally { payload.fill(0); }
      }
    } catch (error) {
      this.#fatal(error, 1002);
    }
  }
}

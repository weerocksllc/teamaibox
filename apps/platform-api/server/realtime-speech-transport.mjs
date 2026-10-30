import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

const CONTENT_TYPES = new Map([
  ["audio/wav", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/webm", "webm"],
  ["audio/ogg", "ogg"],
  ["audio/flac", "flac"],
  ["audio/mpeg", "mp3"],
  ["audio/mp4", "m4a"],
]);
const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;

function boundedString(value, name, maximum = 512) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\r\n\0]/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function workerOrigin(value, { secure = false } = {}) {
  const parsed = new URL(value);
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || parsed.username || parsed.password
      || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new TypeError("Realtime speech worker origin is invalid");
  }
  if (secure && parsed.protocol !== "https:") throw new TypeError("Secure realtime speech transport requires HTTPS");
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]).has(parsed.hostname);
  if (parsed.protocol === "http:" && parsed.hostname.includes(".") && !loopback) {
    throw new TypeError("Plain HTTP realtime speech transport is limited to a private container service name");
  }
  return parsed.origin;
}

function multipart({ audio, contentType, model, language }) {
  const extension = CONTENT_TYPES.get(contentType);
  if (!extension) throw new PlatformError("realtime_audio_format_invalid", "Realtime audio format is unsupported", { status: 400 });
  const boundary = `teamaibox-realtime-${randomUUID()}`;
  const fields = [
    `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="timestamp_granularities[]"\r\n\r\nsegment\r\n`,
    ...(language ? [`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${language}\r\n`] : []),
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chunk.${extension}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  ];
  const body = Buffer.concat([
    ...fields.map((value) => Buffer.from(value, "utf8")),
    audio,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);
  return Object.freeze({ body, contentType: `multipart/form-data; boundary=${boundary}` });
}

function normalizedResponse(value) {
  const text = value?.text;
  const language = value?.language ?? null;
  const duration = Number(value?.duration ?? 0);
  const segments = Array.isArray(value?.segments) ? value.segments.map((item, index) => ({
    id: Number.isSafeInteger(item?.id) ? item.id : index,
    start: Number(item?.start),
    end: Number(item?.end),
    text: item?.text,
  })) : [];
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024
      || (language !== null && (typeof language !== "string" || !LANGUAGE.test(language)))
      || !Number.isFinite(duration) || duration < 0 || duration > 600
      || segments.length > 10_000 || segments.some((item) => typeof item.text !== "string"
        || !Number.isFinite(item.start) || !Number.isFinite(item.end) || item.start < 0 || item.end < item.start || item.end > 600)) {
    throw new PlatformError("realtime_worker_invalid", "Realtime speech worker returned an invalid transcript", { status: 502 });
  }
  return Object.freeze({ text, language, duration, segments: Object.freeze(segments.map(Object.freeze)) });
}

export class OpenAiRealtimeSpeechTransport {
  #origin;
  #model;
  #maximumChunkBytes;
  #maximumResponseBytes;
  #timeoutMilliseconds;
  #credential;
  #customCa;
  #serverName;

  constructor({
    origin,
    model,
    maximumChunkBytes = 8 * 1024 * 1024,
    maximumResponseBytes = 8 * 1024 * 1024,
    timeoutMilliseconds = 60_000,
    credential = null,
    customCa = null,
    serverName = null,
  }) {
    const secure = credential !== null || customCa !== null || serverName !== null;
    this.#origin = workerOrigin(origin, { secure });
    this.#model = boundedString(model, "Realtime speech model");
    for (const [value, name, minimum, maximum] of [
      [maximumChunkBytes, "maximum chunk bytes", 1_024, 64 * 1024 * 1024],
      [maximumResponseBytes, "maximum response bytes", 1_024, 64 * 1024 * 1024],
      [timeoutMilliseconds, "request timeout", 1_000, 300_000],
    ]) {
      if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError(`Realtime speech ${name} is invalid`);
    }
    if (credential !== null && (!(credential instanceof Uint8Array) || credential.byteLength < 8 || credential.byteLength > 8_192)) {
      throw new TypeError("Realtime speech credential is invalid");
    }
    if (customCa !== null && (!(customCa instanceof Uint8Array) || customCa.byteLength < 1 || customCa.byteLength > 1024 * 1024)) {
      throw new TypeError("Realtime speech custom CA is invalid");
    }
    if ((credential === null) !== (customCa === null)) throw new TypeError("Realtime speech HTTPS credential and CA must be configured together");
    if (serverName !== null && (typeof serverName !== "string" || !/^[A-Za-z0-9.-]{1,253}$/.test(serverName))) {
      throw new TypeError("Realtime speech TLS server name is invalid");
    }
    this.#maximumChunkBytes = maximumChunkBytes;
    this.#maximumResponseBytes = maximumResponseBytes;
    this.#timeoutMilliseconds = timeoutMilliseconds;
    this.#credential = credential ? Buffer.from(credential) : null;
    this.#customCa = customCa ? Buffer.from(customCa) : null;
    this.#serverName = serverName;
  }

  get maximumChunkBytes() { return this.#maximumChunkBytes; }

  async transcribe({ audio, contentType = "audio/wav", language = null, signal = undefined }) {
    if (!Buffer.isBuffer(audio) || audio.byteLength < 44 || audio.byteLength > this.#maximumChunkBytes) {
      throw new PlatformError("realtime_audio_invalid", "Realtime audio chunk is empty or exceeds the configured limit", { status: 400 });
    }
    if (language !== null && (typeof language !== "string" || !LANGUAGE.test(language))) {
      throw new PlatformError("realtime_language_invalid", "Realtime transcription language is invalid", { status: 400 });
    }
    const encoded = multipart({ audio, contentType, model: this.#model, language });
    const target = new URL("/v1/audio/transcriptions", this.#origin);
    const requestImplementation = target.protocol === "https:" ? httpsRequest : httpRequest;
    let timeout;
    try {
      const response = await new Promise((resolve, reject) => {
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
        timeout = setTimeout(() => controller.abort(new Error("realtime speech worker timeout")), this.#timeoutMilliseconds);
        timeout.unref?.();
        const request = requestImplementation(target, {
          method: "POST",
          signal: controller.signal,
          ca: this.#customCa ?? undefined,
          servername: this.#serverName ?? undefined,
          headers: {
            accept: "application/json",
            "content-type": encoded.contentType,
            "content-length": String(encoded.body.byteLength),
            ...(this.#credential ? { authorization: `Bearer ${this.#credential.toString("utf8")}` } : {}),
          },
        }, (incoming) => {
          const chunks = [];
          let size = 0;
          incoming.on("data", (chunk) => {
            size += chunk.byteLength;
            if (size > this.#maximumResponseBytes) incoming.destroy(new Error("response too large"));
            else chunks.push(chunk);
          });
          incoming.once("error", reject);
          incoming.once("end", () => {
            signal?.removeEventListener("abort", abort);
            const body = Buffer.concat(chunks);
            try {
              let parsed = null;
              try { parsed = body.byteLength ? JSON.parse(body.toString("utf8")) : null; }
              catch { throw new PlatformError("realtime_worker_invalid", "Realtime speech worker returned invalid JSON", { status: 502 }); }
              resolve({ status: incoming.statusCode ?? 0, body: parsed });
            } finally { body.fill(0); }
          });
        });
        request.once("error", reject);
        request.end(encoded.body);
      });
      if (response.status < 200 || response.status >= 300) {
        throw new PlatformError("realtime_worker_unavailable", "Realtime speech worker rejected the audio chunk", {
          status: 503,
          retryable: true,
          details: { upstreamStatus: response.status },
        });
      }
      return normalizedResponse(response.body);
    } catch (error) {
      if (error instanceof PlatformError) throw error;
      throw new PlatformError("realtime_worker_unavailable", "Realtime speech worker is unavailable", { status: 503, retryable: true, cause: error });
    } finally {
      clearTimeout(timeout);
      encoded.body.fill(0);
    }
  }

  close() {
    this.#credential?.fill(0);
    this.#customCa?.fill(0);
  }
}

export const realtimeSpeechContentTypes = Object.freeze([...CONTENT_TYPES.keys()]);

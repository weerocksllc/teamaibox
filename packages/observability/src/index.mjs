import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

const correlationStorage = new AsyncLocalStorage();
const CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SENSITIVE_KEY = /(authorization|cookie|credential|password|secret|token|private.?key|session)/i;
const PRIVATE_KEY_MATERIAL = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/i;
const AUTHORIZATION_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]{4,}/gi;
const SECRET_ASSIGNMENT = /\b(password|passwd|token|secret|api[_-]?key|authorization)\s*[:=]\s*([^\s,;]+)/gi;
const URI_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s\/@:]+:[^\s\/@]+@/gi;
const JWT_VALUE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

function redactString(value) {
  if (PRIVATE_KEY_MATERIAL.test(value)) return "[REDACTED]";
  return value
    .replace(AUTHORIZATION_VALUE, "$1 [REDACTED]")
    .replace(SECRET_ASSIGNMENT, "$1=[REDACTED]")
    .replace(URI_USERINFO, "$1[REDACTED]@")
    .replace(JWT_VALUE, "[REDACTED_JWT]");
}

export function normalizeCorrelationId(candidate) {
  if (Array.isArray(candidate)) candidate = candidate[0];
  if (typeof candidate === "string" && CORRELATION_ID.test(candidate)) return candidate;
  return randomUUID();
}

export function correlationIdFromRequest(request) {
  return normalizeCorrelationId(request?.headers?.["x-correlation-id"]);
}

export function runWithCorrelation(correlationId, operation) {
  if (typeof operation !== "function") throw new TypeError("correlation operation must be a function");
  return correlationStorage.run(
    Object.freeze({ correlationId: normalizeCorrelationId(correlationId) }),
    operation,
  );
}

export function currentCorrelationId() {
  return correlationStorage.getStore()?.correlationId ?? null;
}

export class PlatformError extends Error {
  constructor(code, message, {
    status = 500,
    retryable = false,
    details = null,
    cause,
  } = {}) {
    super(message, cause ? { cause } : undefined);
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(code)) throw new TypeError("platform error code is invalid");
    if (!Number.isInteger(status) || status < 400 || status > 599) throw new TypeError("platform error status is invalid");
    this.name = "PlatformError";
    this.code = code;
    this.status = status;
    this.retryable = Boolean(retryable);
    this.details = details;
  }
}

export function redact(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    return "[REDACTED_BYTES]";
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      code: typeof value.code === "string" ? value.code : undefined,
      message: value instanceof PlatformError ? redactString(value.message) : "internal error",
    };
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === "object") {
    const output = {};
    for (const [childKey, child] of Object.entries(value)) {
      output[childKey] = redact(child, childKey);
    }
    return output;
  }
  if (typeof value === "string") return redactString(value);
  if (["number", "boolean"].includes(typeof value) || value === null) return value;
  return String(value);
}

export function errorResponse(error, correlationId = currentCorrelationId()) {
  if (error instanceof PlatformError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          correlationId,
          ...(error.details === null ? {} : { details: redact(error.details) }),
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "internal_error",
        message: "The service could not complete the request.",
        retryable: false,
        correlationId,
      },
    },
  };
}

export function createStructuredLogger({ service, destination = process.stdout, clock = () => new Date() }) {
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(service)) throw new TypeError("logger service name is invalid");
  if (!destination || typeof destination.write !== "function") throw new TypeError("logger destination is invalid");

  function write(level, event, fields = {}) {
    if (!/^[a-z][a-z0-9._-]{2,127}$/.test(event)) throw new TypeError("log event name is invalid");
    const record = {
      ...redact(fields),
      timestamp: clock().toISOString(),
      level,
      service,
      event,
      correlationId: currentCorrelationId(),
    };
    destination.write(JSON.stringify(record) + "\n");
    return record;
  }

  return Object.freeze({
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  });
}

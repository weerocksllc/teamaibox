const KEY = /^[A-Z][A-Z0-9_]{1,63}$/;
const SECRET_REF = /^[a-z][a-z0-9._-]{2,127}$/;
const SENSITIVE_KEY = /(CREDENTIAL|PASSWORD|SECRET|TOKEN|PRIVATE_KEY|SESSION)/;

export class ConfigurationError extends Error {
  constructor(issues) {
    super("configuration validation failed");
    this.name = "ConfigurationError";
    this.code = "invalid_configuration";
    this.issues = issues.map((issue) => ({ ...issue }));
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      issues: this.issues,
    };
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function parseBoolean(raw) {
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error("must be true, false, 1, or 0");
}

function parseInteger(raw, descriptor) {
  if (!/^-?[0-9]+$/.test(raw)) throw new Error("must be an integer");
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error("must be a safe integer");
  if (descriptor.minimum !== undefined && value < descriptor.minimum) {
    throw new Error("must be at least " + descriptor.minimum);
  }
  if (descriptor.maximum !== undefined && value > descriptor.maximum) {
    throw new Error("must be at most " + descriptor.maximum);
  }
  return value;
}

function parseValue(raw, descriptor) {
  switch (descriptor.type) {
    case "string":
      if (descriptor.minimumLength !== undefined && raw.length < descriptor.minimumLength) {
        throw new Error("must contain at least " + descriptor.minimumLength + " characters");
      }
      if (descriptor.maximumLength !== undefined && raw.length > descriptor.maximumLength) {
        throw new Error("must contain at most " + descriptor.maximumLength + " characters");
      }
      if (descriptor.pattern && !descriptor.pattern.test(raw)) {
        throw new Error("has an invalid format");
      }
      return raw;
    case "integer":
      return parseInteger(raw, descriptor);
    case "boolean":
      return parseBoolean(raw);
    case "enum":
      if (!descriptor.values?.includes(raw)) throw new Error("must be an allowed value");
      return raw;
    case "url": {
      const value = new URL(raw);
      if (descriptor.protocols && !descriptor.protocols.includes(value.protocol)) {
        throw new Error("uses a disallowed URL protocol");
      }
      if (value.username || value.password) throw new Error("must not contain URL credentials");
      return value.href;
    }
    case "secret-ref":
      if (!SECRET_REF.test(raw)) throw new Error("must be a valid protected-secret reference");
      return raw;
    default:
      throw new Error("uses an unsupported schema type");
  }
}

function validateSchema(prefix, schema) {
  if (typeof prefix !== "string" || !KEY.test(prefix.replace(/_$/, ""))) {
    throw new TypeError("configuration prefix must be an uppercase environment prefix");
  }
  if (!prefix.endsWith("_")) throw new TypeError("configuration prefix must end with an underscore");
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new TypeError("configuration schema must be an object");
  }
  const environmentKeys = new Set();
  for (const [property, descriptor] of Object.entries(schema)) {
    if (!/^[a-z][a-zA-Z0-9]{1,63}$/.test(property)) {
      throw new TypeError("configuration property is invalid: " + property);
    }
    if (!descriptor || typeof descriptor !== "object") {
      throw new TypeError("configuration descriptor is invalid: " + property);
    }
    const environmentKey = descriptor.environment ?? prefix + property.replace(/[A-Z]/g, (value) => "_" + value).toUpperCase();
    if (!KEY.test(environmentKey) || !environmentKey.startsWith(prefix)) {
      throw new TypeError("configuration environment key is outside the prefix: " + environmentKey);
    }
    if (environmentKeys.has(environmentKey)) {
      throw new TypeError("configuration environment key is duplicated: " + environmentKey);
    }
    environmentKeys.add(environmentKey);
  }
  return environmentKeys;
}

export function loadConfiguration({
  environment = process.env,
  prefix,
  schema,
  allowUnknown = false,
}) {
  const environmentKeys = validateSchema(prefix, schema);
  const issues = [];
  const configuration = {};

  if (!allowUnknown) {
    for (const key of Object.keys(environment)) {
      if (key.startsWith(prefix) && !environmentKeys.has(key)) {
        issues.push({ key, reason: "unknown_key" });
      }
    }
  }

  for (const [property, descriptor] of Object.entries(schema)) {
    const key = descriptor.environment ?? prefix + property.replace(/[A-Z]/g, (value) => "_" + value).toUpperCase();
    const raw = environment[key];
    if (raw === undefined || raw === "") {
      if (Object.hasOwn(descriptor, "default")) {
        configuration[property] = structuredClone(descriptor.default);
      } else if (descriptor.required !== false) {
        issues.push({ key, reason: "missing_required" });
      }
      continue;
    }
    try {
      const value = parseValue(String(raw), descriptor);
      if (descriptor.validate) {
        const outcome = descriptor.validate(value);
        if (outcome !== true) throw new Error(typeof outcome === "string" ? outcome : "failed custom validation");
      }
      configuration[property] = value;
    } catch (error) {
      const sensitive = descriptor.sensitive === true || SENSITIVE_KEY.test(key);
      issues.push({
        key,
        reason: "invalid_value",
        message: sensitive ? "invalid sensitive value" : error.message,
        received: sensitive ? "[REDACTED]" : String(raw),
      });
    }
  }

  if (issues.length > 0) throw new ConfigurationError(issues);
  return deepFreeze(configuration);
}

export const configurationTypes = Object.freeze([
  "string",
  "integer",
  "boolean",
  "enum",
  "url",
  "secret-ref",
]);

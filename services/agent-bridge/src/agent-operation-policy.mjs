import { createHash } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

const KEY = /^[a-z][a-z0-9_.-]{1,127}$/;
const DISPOSITIONS = new Set(["allow", "confirm", "deny"]);
const SIDE_EFFECTS = new Set(["none", "idempotent", "non_idempotent"]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function action(value) {
  let scope;
  let scopeJSON;
  try {
    scope = structuredClone(value?.scope);
    scopeJSON = JSON.stringify(scope);
  } catch {
    throw new PlatformError("agent_operation_invalid", "Agent operation declaration is invalid", { status: 400 });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.kind !== "string" || !KEY.test(value.kind)
    || typeof value.tool !== "string" || !KEY.test(value.tool)
    || typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 512
    || !scope || typeof scope !== "object" || Array.isArray(scope) || typeof scopeJSON !== "string"
    || Buffer.byteLength(scopeJSON) > 32 * 1024) {
    throw new PlatformError("agent_operation_invalid", "Agent operation declaration is invalid", { status: 400 });
  }
  const normalized = canonical({ kind: value.kind, tool: value.tool, summary: value.summary.trim(), scope });
  return Object.freeze({ ...normalized, digest: `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}` });
}

function policy(value) {
  if (!value || value.schemaVersion !== 1 || value.policyId !== "official-agent-operations.v1"
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.confirmationTimeoutSeconds) || value.confirmationTimeoutSeconds < 15 || value.confirmationTimeoutSeconds > 900
    || value.alwaysReplyAllowed !== false || !DISPOSITIONS.has(value.defaultDisposition)
    || !SIDE_EFFECTS.has(value.defaultSideEffectClass) || !Array.isArray(value.rules)) {
    throw new TypeError("Agent operation policy is invalid");
  }
  const rules = new Map();
  for (const rule of value.rules) {
    if (!rule || typeof rule.actionKind !== "string" || !KEY.test(rule.actionKind)
      || !DISPOSITIONS.has(rule.disposition) || !SIDE_EFFECTS.has(rule.sideEffectClass)
      || rules.has(rule.actionKind) || (rule.disposition === "allow" && rule.sideEffectClass !== "none")) {
      throw new TypeError("Agent operation policy rule is invalid");
    }
    rules.set(rule.actionKind, Object.freeze({ disposition: rule.disposition, sideEffectClass: rule.sideEffectClass }));
  }
  if (JSON.stringify([...rules.keys()]) !== JSON.stringify([...rules.keys()].sort())) throw new TypeError("Agent operation policy rules must be sorted");
  return Object.freeze({
    policyId: value.policyId,
    revision: value.revision,
    timeoutMs: value.confirmationTimeoutSeconds * 1000,
    defaultDisposition: value.defaultDisposition,
    defaultSideEffectClass: value.defaultSideEffectClass,
    rules,
  });
}

export class AgentOperationPolicy {
  #policy;

  constructor({ policy: value }) {
    this.#policy = policy(value);
  }

  evaluate(value, now = new Date()) {
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError("Agent operation policy clock is invalid");
    const normalized = action(value);
    const rule = this.#policy.rules.get(normalized.kind) ?? {
      disposition: this.#policy.defaultDisposition,
      sideEffectClass: this.#policy.defaultSideEffectClass,
    };
    return Object.freeze({
      action: normalized,
      disposition: rule.disposition,
      sideEffectClass: rule.sideEffectClass,
      policyId: this.#policy.policyId,
      policyRevision: this.#policy.revision,
      expiresAt: new Date(now.getTime() + this.#policy.timeoutMs),
    });
  }
}

export const agentOperationDigest = (value) => action(value).digest;

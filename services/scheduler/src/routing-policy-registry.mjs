import { randomUUID } from "node:crypto";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { normalizeRoutingPolicy } from "./routing-engine.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9_.-]{2,127}$/;
const OPERATION = /^[a-z][a-z0-9_.-]{1,127}$/;
const DATA_CLASSES = new Set(["public", "internal", "confidential", "restricted"]);

function fail(code, message, status = 400) { throw new PlatformError(code, message, { status }); }
function actor(context, permission) {
  const identityId = context?.identityId ?? context?.identity?.id;
  if (!UUID.test(identityId ?? "") || !new Set(context?.permissions ?? []).has(permission)) fail("access_denied", `Missing permission: ${permission}`, 403);
  return identityId;
}
function uuid(value, name, optional = false) { if (optional && value == null) return null; if (!UUID.test(value ?? "")) fail("routing_policy_invalid", `${name} is invalid`); return value; }
function integer(value, name, minimum, maximum) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("routing_policy_invalid", `${name} is invalid`); return value; }

function selector(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("routing_policy_invalid", "selector is invalid");
  const operation = value.operation ?? null;
  if (operation !== null && (typeof operation !== "string" || !OPERATION.test(operation))) fail("routing_policy_invalid", "selector.operation is invalid");
  const classes = value.dataClasses ?? [];
  if (!Array.isArray(classes) || classes.length > 4 || classes.some((item) => !DATA_CLASSES.has(item))) fail("routing_policy_invalid", "selector.dataClasses is invalid");
  return Object.freeze({
    capabilityId: uuid(value.capabilityId, "selector.capabilityId", true),
    operation,
    teamId: uuid(value.teamId, "selector.teamId", true),
    dataClasses: Object.freeze([...new Set(classes)].sort()),
  });
}

function normalizeDeclaration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !KEY.test(value.policyKey ?? "") || typeof value.displayName !== "string" || !value.displayName.trim() || value.displayName.length > 128) fail("routing_policy_invalid", "Routing policy declaration is invalid");
  let policy;
  try { policy = normalizeRoutingPolicy(value.routing); } catch (error) { fail("routing_policy_invalid", error.message); }
  return Object.freeze({
    policyKey: value.policyKey,
    displayName: value.displayName.trim(),
    selector: selector(value.selector),
    priority: integer(value.priority ?? 100, "priority", 0, 10_000),
    routing: policy,
    enabled: value.enabled !== false,
  });
}

function publicPolicy(value) {
  return Object.freeze({ ...structuredClone(value), createdAt: new Date(value.createdAt).toISOString(), updatedAt: new Date(value.updatedAt).toISOString() });
}
function specificity(policy) {
  return Number(policy.selector.capabilityId !== null) + Number(policy.selector.operation !== null)
    + Number(policy.selector.teamId !== null) + Number(policy.selector.dataClasses.length > 0);
}
function matches(policy, job) {
  return policy.enabled
    && (policy.selector.capabilityId === null || policy.selector.capabilityId === job.capabilityId)
    && (policy.selector.operation === null || policy.selector.operation === job.operation)
    && (policy.selector.teamId === null || policy.selector.teamId === job.teamId)
    && (policy.selector.dataClasses.length === 0 || policy.selector.dataClasses.includes(job.dataClass));
}
function translated(error) {
  if (typeof error?.code === "string" && error.code.startsWith("routing_policy_")) fail(error.code, error.message, 409);
  throw error;
}

export class RoutingPolicyRegistry {
  #repository; #clock; #audit; #idFactory;
  constructor({ repository, clock = () => new Date(), audit = async () => {}, idFactory = randomUUID }) {
    const methods = ["list", "findById", "findByKey", "create", "update"];
    if (!repository || methods.some((method) => typeof repository[method] !== "function") || typeof clock !== "function" || typeof audit !== "function" || typeof idFactory !== "function") throw new TypeError("Routing policy registry dependencies are incomplete");
    this.#repository = repository; this.#clock = clock; this.#audit = audit; this.#idFactory = idFactory;
  }
  async list({ context }) { actor(context, "provider:view"); return Object.freeze({ object: "list", data: Object.freeze((await this.#repository.list()).map(publicPolicy)) }); }
  async get({ context, policyId }) { actor(context, "provider:view"); const value = await this.#repository.findById(uuid(policyId, "policyId")); if (!value) fail("routing_policy_not_found", "Routing policy was not found", 404); return publicPolicy(value); }
  async create({ context, declaration }) {
    const owner = actor(context, "provider:manage"), normalized = normalizeDeclaration(declaration);
    if (await this.#repository.findByKey(normalized.policyKey)) fail("routing_policy_key_conflict", "Routing policy key already exists", 409);
    const now = this.#clock();
    const value = await this.#repository.create({ ...normalized, policyId: uuid(this.#idFactory(), "policyId"), revision: 1, createdBy: owner, createdAt: now, updatedAt: now }).catch(translated);
    await this.#audit({ action: "routing_policy.created", actorIdentityId: owner, policyId: value.policyId, policyKey: value.policyKey, mode: value.routing.mode, occurredAt: now.toISOString() });
    return publicPolicy(value);
  }
  async update({ context, policyId, expectedRevision, declaration }) {
    const owner = actor(context, "provider:manage"), id = uuid(policyId, "policyId"), current = await this.#repository.findById(id);
    if (!current) fail("routing_policy_not_found", "Routing policy was not found", 404);
    const normalized = normalizeDeclaration({ ...current, ...structuredClone(declaration), selector: { ...current.selector, ...declaration?.selector }, routing: { ...current.routing, ...declaration?.routing } });
    const now = this.#clock();
    const value = await this.#repository.update(id, integer(expectedRevision, "expectedRevision", 1, Number.MAX_SAFE_INTEGER), { ...normalized, updatedAt: now }).catch(translated);
    if (!value) fail("routing_policy_not_found", "Routing policy was not found", 404);
    await this.#audit({ action: "routing_policy.updated", actorIdentityId: owner, policyId: id, revision: value.revision, mode: value.routing.mode, occurredAt: now.toISOString() });
    return publicPolicy(value);
  }
  async resolve(job) {
    if (!job?.capabilityId || !job.operation || !DATA_CLASSES.has(job.dataClass) || (job.teamId != null && !UUID.test(job.teamId))) throw new TypeError("job routing facts are invalid");
    const candidates = (await this.#repository.list()).filter((policy) => matches(policy, job)).sort((left, right) =>
      specificity(right) - specificity(left)
      || right.priority - left.priority
      || left.policyKey.localeCompare(right.policyKey));
    const selected = candidates[0] ?? null;
    const routing = selected?.routing ?? normalizeRoutingPolicy({ mode: "internal_only" });
    return Object.freeze({
      ...structuredClone(routing),
      policyId: selected?.policyId ?? null,
      policyKey: selected?.policyKey ?? "platform.default.internal-only",
      policyRevision: selected?.revision ?? 1,
      explanationCode: selected ? `routing.policy.${selected.policyKey}` : "routing.policy.default_internal_only",
    });
  }
}

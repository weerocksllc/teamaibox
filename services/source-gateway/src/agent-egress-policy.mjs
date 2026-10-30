import { isIP } from "node:net";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/;

function publicAddress(value) {
  if (isIP(value) === 4) {
    const parts = value.split(".").map(Number);
    return !(parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224
      || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && (parts[1] === 0 || parts[1] === 168))
      || (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19 || parts[1] === 51))
      || (parts[0] === 203 && parts[1] === 0 && parts[2] === 113)
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127));
  }
  if (isIP(value) === 6) {
    const normalized = value.toLowerCase();
    return (normalized.startsWith("2") || normalized.startsWith("3"))
      && !normalized.startsWith("2001:db8:") && !normalized.startsWith("2001:2:")
      && !normalized.startsWith("2001:10:") && !normalized.startsWith("2001:20:")
      && !normalized.startsWith("::ffff:");
  }
  return false;
}

function validated(policy) {
  const repositories = policy?.packageRepositories;
  const internet = policy?.generalInternet;
  if (policy?.schemaVersion !== 1 || policy.policyId !== "official-agent-egress.v1"
    || !Number.isSafeInteger(policy.revision) || policy.revision < 1
    || repositories?.enabled !== true || repositories.mode !== "internal-only"
    || repositories.gatewayHost !== "source-gateway" || repositories.exposeUpstreamCredentials !== false
    || typeof internet?.enabled !== "boolean" || internet.proxyHost !== "agent-egress-gateway"
    || internet.proxyUrl !== "http://agent-egress-gateway:8080" || !Array.isArray(internet.allowedHosts)) {
    throw new TypeError("Agent egress policy is invalid");
  }
  const allowed = internet.allowedHosts.map((value) => String(value).toLowerCase());
  if (new Set(allowed).size !== allowed.length || JSON.stringify(allowed) !== JSON.stringify([...allowed].sort())
    || allowed.some((host) => !HOST.test(host) || host.includes("*") || isIP(host) !== 0)
    || (!internet.enabled && allowed.length > 0)) {
    throw new TypeError("Agent Internet allowlist is invalid");
  }
  return Object.freeze({ revision: policy.revision, enabled: internet.enabled, allowed: new Set(allowed) });
}

export class AgentEgressAuthorizer {
  #policy;
  #resolve;
  #audit;

  constructor({ policy, resolve, audit = async () => {} }) {
    if (typeof resolve !== "function" || typeof audit !== "function") throw new TypeError("Agent egress authorizer dependencies are incomplete");
    this.#policy = validated(policy);
    this.#resolve = resolve;
    this.#audit = audit;
  }

  async authorize({ sandboxId, hostname, port, protocol }) {
    const host = String(hostname ?? "").toLowerCase();
    if (typeof sandboxId !== "string" || !UUID.test(sandboxId) || !HOST.test(host) || isIP(host) !== 0
      || !new Set(["http:", "https:"]).has(protocol) || !Number.isSafeInteger(port)
      || (protocol === "http:" && port !== 80) || (protocol === "https:" && port !== 443)) {
      throw new PlatformError("agent_egress_request_invalid", "Agent Internet request is invalid", { status: 400 });
    }
    if (!this.#policy.enabled || !this.#policy.allowed.has(host)) {
      await this.#audit({ action: "agent.egress_denied", sandboxId, host, port, protocol, policyRevision: this.#policy.revision, reason: "administrator_policy" });
      throw new PlatformError("agent_egress_denied", "Agent Internet destination is denied by administrator policy", { status: 403 });
    }
    const addresses = await this.#resolve(host);
    if (!Array.isArray(addresses) || addresses.length === 0
      || addresses.some((value) => !value || typeof value.address !== "string" || !publicAddress(value.address))) {
      await this.#audit({ action: "agent.egress_denied", sandboxId, host, port, protocol, policyRevision: this.#policy.revision, reason: "non_public_resolution" });
      throw new PlatformError("agent_egress_resolution_denied", "Agent Internet destination resolved outside public address space", { status: 403 });
    }
    const decision = Object.freeze({
      sandboxId, hostname: host, port, protocol,
      address: addresses[0].address,
      policyRevision: this.#policy.revision,
    });
    await this.#audit({ action: "agent.egress_allowed", sandboxId, host, port, protocol, policyRevision: this.#policy.revision });
    return decision;
  }
}

export const isPublicAgentEgressAddress = publicAddress;

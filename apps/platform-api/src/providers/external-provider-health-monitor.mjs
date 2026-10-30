import { NodeHttpsProviderTransport } from "../../../../services/scheduler/src/external-provider-contract-tester.mjs";

const PROVIDER_READER = Object.freeze({
  service: "provider-adapter",
  permissions: Object.freeze(["secrets:read"]),
});

const TRANSPORT_ERROR_CODES = Object.freeze({
  CERT_HAS_EXPIRED: "provider_tls_certificate_expired",
  ERR_TLS_CERT_ALTNAME_INVALID: "provider_tls_identity_mismatch",
  DEPTH_ZERO_SELF_SIGNED_CERT: "provider_tls_untrusted_certificate",
  SELF_SIGNED_CERT_IN_CHAIN: "provider_tls_untrusted_certificate",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "provider_tls_untrusted_certificate",
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "provider_tls_untrusted_certificate",
  ECONNREFUSED: "provider_connection_refused",
  ECONNRESET: "provider_connection_reset",
  ENOTFOUND: "provider_dns_failed",
  EAI_AGAIN: "provider_dns_failed",
  EHOSTUNREACH: "provider_host_unreachable",
  ENETUNREACH: "provider_network_unreachable",
  ETIMEDOUT: "provider_timeout",
  ABORT_ERR: "provider_request_aborted",
});

// Persist stable error classes, never Node's uppercase codes or raw messages.
// Invalid codes otherwise roll back the entire health observation in PostgreSQL.
function observationErrorCode(error) {
  const code = error?.code;
  if (typeof code !== "string") return "provider_health_probe_failed";
  if (Object.hasOwn(TRANSPORT_ERROR_CODES, code)) return TRANSPORT_ERROR_CODES[code];
  return /^[a-z][a-z0-9_:.-]{1,191}$/.test(code) ? code : "provider_health_probe_failed";
}

export class ExternalProviderHealthMonitor {
  #repository;
  #secrets;
  #transport;
  #clock;
  #audit;
  #onObservationError;
  #intervalMilliseconds;
  #timer = null;
  #running = null;
  #nextProbeAt = new Map();

  constructor({
    repository,
    secretStore,
    transport = new NodeHttpsProviderTransport(),
    clock = () => new Date(),
    audit = async () => {},
    onObservationError = async () => {},
    intervalMilliseconds = 10_000,
  }) {
    if (!repository?.list || !repository?.recordHealth || !secretStore?.withSecret || !transport?.request
        || typeof clock !== "function" || typeof audit !== "function" || typeof onObservationError !== "function"
        || !Number.isSafeInteger(intervalMilliseconds) || intervalMilliseconds < 1_000 || intervalMilliseconds > 86_400_000) {
      throw new TypeError("External provider health monitor dependencies are incomplete");
    }
    this.#repository = repository;
    this.#secrets = secretStore;
    this.#transport = transport;
    this.#clock = clock;
    this.#audit = audit;
    this.#onObservationError = onObservationError;
    this.#intervalMilliseconds = intervalMilliseconds;
  }

  #withSecrets(provider, callback) {
    const withCa = (credential) => provider.caSecretKey
      ? this.#secrets.withSecret(provider.caSecretKey, PROVIDER_READER, (customCa) => callback(credential, customCa))
      : callback(credential, null);
    return provider.credentialSecretKey
      ? this.#secrets.withSecret(provider.credentialSecretKey, PROVIDER_READER, (credential) => withCa(credential))
      : withCa(null);
  }

  async #probe(provider) {
    const started = performance.now();
    try {
      const response = await this.#withSecrets(provider, (credential, customCa) => this.#transport.request({
        provider,
        credential,
        customCa,
        method: "GET",
        path: provider.healthCheck.path,
        timeoutMilliseconds: provider.healthCheck.timeoutMilliseconds,
        signal: AbortSignal.timeout(provider.healthCheck.timeoutMilliseconds),
      }));
      return {
        passed: response.status >= 200 && response.status < 300,
        latencyMilliseconds: response.latencyMilliseconds ?? Math.round(performance.now() - started),
        errorCode: response.status >= 200 && response.status < 300 ? null : "provider_health_http_status",
      };
    } catch (error) {
      return {
        passed: false,
        latencyMilliseconds: Math.round(performance.now() - started),
        errorCode: observationErrorCode(error),
      };
    }
  }

  async #observe(provider, startedAt) {
    const result = await this.#probe(provider);
    const consecutiveFailures = result.passed ? 0 : (provider.health?.consecutiveFailures ?? 0) + 1;
    const unavailable = !result.passed && consecutiveFailures >= provider.healthCheck.failureThreshold;
    const observedAt = this.#clock();
    const next = await this.#repository.recordHealth(provider.providerId, {
      lifecycleState: result.passed ? "healthy" : unavailable ? "unavailable" : "degraded",
      health: {
        state: result.passed ? "healthy" : unavailable ? "unavailable" : "degraded",
        latencyMilliseconds: result.latencyMilliseconds,
        errorCode: result.errorCode,
        observedAt,
        consecutiveFailures,
      },
    });
    if (next) await this.#audit({
      action: "provider.health_observed",
      providerId: provider.providerId,
      providerKey: provider.providerKey,
      state: next.health.state,
      consecutiveFailures,
      errorCode: result.errorCode,
      occurredAt: observedAt.toISOString(),
      probeStartedAt: startedAt.toISOString(),
    });
  }

  async tick() {
    if (this.#running) return this.#running;
    this.#running = (async () => {
      const observations = [];
      const providers = this.#repository.listRoutable
        ? await this.#repository.listRoutable()
        : await this.#repository.list();
      for (const provider of providers) {
        if (provider.providerKind && provider.providerKind !== 'external_openai') continue;
        if (provider.lifecycleState === "disabled" || provider.lifecycleState === "removed"
            || provider.contract?.state !== "passed") continue;
        const startedAt = this.#clock();
        if ((this.#nextProbeAt.get(provider.providerId) ?? 0) > startedAt.getTime()) continue;
        this.#nextProbeAt.set(provider.providerId, startedAt.getTime() + provider.healthCheck.intervalSeconds * 1_000);
        observations.push(this.#observe(provider, startedAt).catch(async (error) => {
          await this.#onObservationError({ providerId: provider.providerId,
            errorCode: observationErrorCode(error) });
        }));
      }
      // Start every due probe before awaiting any one Provider. A slow or broken
      // endpoint must not make later Providers stale, and one persistence/audit
      // failure must not cancel observations that are already in flight.
      await Promise.allSettled(observations);
    })().finally(() => { this.#running = null; });
    return this.#running;
  }

  start() {
    if (this.#timer) return;
    void this.tick().catch(() => {});
    this.#timer = setInterval(() => { void this.tick().catch(() => {}); }, this.#intervalMilliseconds);
    this.#timer.unref();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#nextProbeAt.clear();
  }
}

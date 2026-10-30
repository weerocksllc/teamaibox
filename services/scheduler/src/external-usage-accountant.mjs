import { PlatformError } from "../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCY = /^[A-Z]{3}$/;
function fail(code, message, status = 400) { throw new PlatformError(code, message, { status }); }
function integer(value, name) { if (!Number.isSafeInteger(value) || value < 0) fail("external_usage_invalid", `${name} is invalid`); return value; }
function rate(value, name) { if (!Number.isSafeInteger(value) || value < 0) fail("external_usage_invalid", `${name} is invalid`); return value; }
function portion(units, microunits, divisor) {
  if (units === 0 || microunits === 0) return 0n;
  const numerator = BigInt(units) * BigInt(microunits);
  return (numerator + BigInt(divisor) - 1n) / BigInt(divisor);
}

function exactCost(normalized, rates) {
  const total = portion(normalized.inputTokens, rates.inputMicrounitsPerMillionTokens, 1_000_000)
    + portion(normalized.outputTokens, rates.outputMicrounitsPerMillionTokens, 1_000_000)
    + BigInt(normalized.imageRequests) * BigInt(rates.imageMicrounitsPerRequest)
    + portion(normalized.audioMilliseconds, rates.audioMicrounitsPerMinute, 60_000);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) fail("external_usage_cost_overflow", "External usage cost exceeds the exact accounting range");
  return Number(total);
}

export class ExternalUsageAccountant {
  #repository; #audit;
  constructor({ repository, audit = async () => {} }) {
    if (!repository?.record || !repository?.findByAttempt || typeof audit !== "function") throw new TypeError("external usage accountant dependencies are incomplete");
    this.#repository = repository; this.#audit = audit;
  }

  async record({ attemptId, jobId, providerId, accounting, usage, observedAt = new Date() }) {
    if (![attemptId, jobId, providerId].every((value) => UUID.test(value ?? ""))) fail("external_usage_invalid", "External usage identity is invalid");
    if (!accounting || !CURRENCY.test(accounting.currency ?? "") || !new Set(["provider_reported", "platform_estimated", "unpriced"]).has(accounting.accountingMode)) fail("external_usage_invalid", "External accounting contract is invalid");
    const normalized = {
      inputTokens: integer(usage?.inputTokens ?? 0, "inputTokens"), outputTokens: integer(usage?.outputTokens ?? 0, "outputTokens"),
      imageRequests: integer(usage?.imageRequests ?? 0, "imageRequests"), audioMilliseconds: integer(usage?.audioMilliseconds ?? 0, "audioMilliseconds"),
      source: usage?.source,
    };
    if (!new Set(["provider_reported", "platform_observed"]).has(normalized.source)
        || (accounting.accountingMode === "provider_reported" && normalized.source !== "provider_reported")) fail("external_usage_invalid", "External usage source does not satisfy the accounting contract");
    const rates = {
      inputMicrounitsPerMillionTokens: rate(accounting.inputMicrounitsPerMillionTokens ?? 0, "input token rate"),
      outputMicrounitsPerMillionTokens: rate(accounting.outputMicrounitsPerMillionTokens ?? 0, "output token rate"),
      imageMicrounitsPerRequest: rate(accounting.imageMicrounitsPerRequest ?? 0, "image rate"),
      audioMicrounitsPerMinute: rate(accounting.audioMicrounitsPerMinute ?? 0, "audio rate"),
    };
    const totalMicrounits = accounting.accountingMode === "unpriced" ? null : exactCost(normalized, rates);
    const value = await this.#repository.record({
      attemptId: attemptId.toLowerCase(), jobId: jobId.toLowerCase(), providerId: providerId.toLowerCase(),
      usage: normalized, accountingMode: accounting.accountingMode, rates,
      currency: accounting.currency, totalMicrounits, observedAt: new Date(observedAt),
    });
    await this.#audit({ action: "compute.external_usage_recorded", attemptId, jobId, providerId, accountingMode: value.accountingMode, currency: value.currency, totalMicrounits: value.totalMicrounits });
    return Object.freeze({ ...value, hardwareMetrics: Object.freeze({ support: "unsupported", cpu: null, memory: null, accelerator: null, power: null }) });
  }

  async get({ attemptId }) {
    if (!UUID.test(attemptId ?? "")) fail("external_usage_invalid", "External attempt identity is invalid");
    const value = await this.#repository.findByAttempt(attemptId.toLowerCase());
    if (!value) fail("external_usage_not_found", "External usage record was not found", 404);
    return Object.freeze({ ...value, hardwareMetrics: Object.freeze({ support: "unsupported", cpu: null, memory: null, accelerator: null, power: null }) });
  }
}

import assert from "node:assert/strict";
import test from "node:test";

import { ExternalUsageAccountant } from "../src/external-usage-accountant.mjs";
import { MemoryExternalUsageRepository } from "../src/memory-external-usage-repository.mjs";

const ATTEMPT = "00000000-0000-4000-8000-000000000101";
const JOB = "00000000-0000-4000-8000-000000000201";
const PROVIDER = "00000000-0000-4000-8000-000000000301";
const accounting = { currency: "USD", inputMicrounitsPerMillionTokens: 100, outputMicrounitsPerMillionTokens: 200, imageMicrounitsPerRequest: 300, audioMicrounitsPerMinute: 400, accountingMode: "provider_reported" };

test("external accounting is immutable, exact, and never fabricates private hardware telemetry", async () => {
  const service = new ExternalUsageAccountant({ repository: new MemoryExternalUsageRepository() });
  const input = { attemptId: ATTEMPT, jobId: JOB, providerId: PROVIDER, accounting, usage: { inputTokens: 1000, outputTokens: 500, imageRequests: 2, audioMilliseconds: 90_000, source: "provider_reported" }, observedAt: new Date("2026-08-11T08:00:00Z") };
  const result = await service.record(input);
  assert.equal(result.totalMicrounits, 1202);
  assert.deepEqual(result.hardwareMetrics, { support: "unsupported", cpu: null, memory: null, accelerator: null, power: null });
  assert.equal((await service.record(input)).totalMicrounits, 1202);
  await assert.rejects(service.record({ ...input, usage: { ...input.usage, outputTokens: 501 } }), { code: "external_usage_conflict" });
});

test("provider-reported contracts reject estimated usage and unpriced providers retain null cost", async () => {
  const service = new ExternalUsageAccountant({ repository: new MemoryExternalUsageRepository() });
  await assert.rejects(service.record({ attemptId: ATTEMPT, jobId: JOB, providerId: PROVIDER, accounting, usage: { source: "platform_observed" } }), { code: "external_usage_invalid" });
  const result = await service.record({ attemptId: ATTEMPT, jobId: JOB, providerId: PROVIDER, accounting: { ...accounting, accountingMode: "unpriced" }, usage: { source: "platform_observed" } });
  assert.equal(result.totalMicrounits, null);
});

test("accounting rounds with integer arithmetic and rejects totals outside the exact range", async () => {
  const service = new ExternalUsageAccountant({ repository: new MemoryExternalUsageRepository() });
  const exact = await service.record({
    attemptId: ATTEMPT, jobId: JOB, providerId: PROVIDER,
    accounting: { ...accounting, inputMicrounitsPerMillionTokens: Number.MAX_SAFE_INTEGER },
    usage: { inputTokens: 1, source: "provider_reported" },
  });
  assert.equal(exact.totalMicrounits, 9_007_199_255);
  await assert.rejects(service.record({
    attemptId: "00000000-0000-4000-8000-000000000102", jobId: JOB, providerId: PROVIDER,
    accounting: { ...accounting, imageMicrounitsPerRequest: Number.MAX_SAFE_INTEGER },
    usage: { imageRequests: 2, source: "provider_reported" },
  }), { code: "external_usage_cost_overflow" });
});

import assert from "node:assert/strict";
import test from "node:test";

import { MemoryModelProfileRepository } from "../src/models/memory-model-profile-repository.mjs";
import {
  ModelProfileRegistrationError,
  ModelProfileRegistrationService,
  modelProfileFingerprintV1,
  validateModelProfileDeclarationV1,
} from "../src/models/model-profile-registration-service.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const context = {
  identityId: "00000000-0000-4000-8000-000000007101",
  permissions: ["model:manage"],
};

function declaration(overrides = {}) {
  return {
    profileKey: "llm.spark.nvfp4.r1",
    capabilityId: "00000000-0000-4000-8000-000000007102",
    executionKind: "local",
    source: {
      model: "example/large-instruct",
      revision: "4f3c2a1",
      license: {
        name: "Example Model License",
        spdxId: "Apache-2.0",
        usage: "commercial",
        reviewStatus: "approved",
        textDigest: digest("1"),
        evidenceRef: "evidence://licenses/example-large-instruct",
      },
      provenance: {
        publisher: "Example Research",
        sourceUri: "https://models.example.test/example/large-instruct",
        retrievedAt: "2026-08-11T08:00:00.000Z",
        sourceDigest: digest("2"),
        evidenceRef: "evidence://provenance/example-large-instruct",
      },
    },
    artifacts: [
      { name: "config", role: "config", digest: digest("b"), sizeBytes: 4096, mediaType: "application/json" },
      { name: "weights", role: "weights", digest: digest("a"), sizeBytes: 64 * 1024 ** 3, mediaType: "application/vnd.safetensors" },
    ],
    artifactDigest: digest("a"),
    engine: {
      name: "tensorrt-llm",
      version: "1.2.0",
      runtime: "cuda",
      runtimeVersion: "13.0",
      imageDigest: digest("c"),
      configurationDigest: digest("d"),
    },
    precision: "nvfp4",
    quantizationRecipe: {
      scheme: "nvfp4",
      tool: "modelopt",
      toolVersion: "0.35.0",
      recipeDigest: digest("e"),
      parametersDigest: digest("f"),
      calibrationDatasetDigest: digest("9"),
    },
    compatibility: {
      architectures: ["linux/arm64/v8"],
      hardware: {
        acceleratorFamilies: ["nvidia-blackwell"],
        minimumComputeCapability: "12.0",
        minimumUnifiedMemoryBytes: 96 * 1024 ** 3,
        minimumCpuCores: 8,
        codecDirections: { encode: 0, decode: 0 },
      },
      software: {
        os: "linux",
        kernelRange: ">=6.8 <7.0",
        driverRange: ">=580.0 <590.0",
        cudaRange: ">=13.0 <14.0",
        containerToolkitRange: ">=1.18 <2.0",
      },
    },
    apiContracts: ["openai.chat-completions@v1", "openai.responses@v1"],
    limits: {
      maximumInputBytes: 16777216,
      maximumOutputBytes: 16777216,
      maximumContextTokens: 131072,
      maximumOutputTokens: 8192,
      maximumBatchSize: 4,
      maximumDurationSeconds: 900,
      maximumConcurrentRequests: 2,
    },
    resourceEnvelope: {
      accountingMode: "observed",
      cpuMillis: 8000,
      unifiedMemoryBytes: 112 * 1024 ** 3,
      storageBytes: 80 * 1024 ** 3,
      networkBitsPerSecond: 1_000_000_000,
      acceleratorUnits: 1,
      codecSessions: 0,
      evidenceRef: "evidence://benchmarks/large-instruct-resource-envelope",
    },
    coldStart: {
      estimatedMilliseconds: 95000,
      artifactReadBytes: 64 * 1024 ** 3,
      evidenceRef: "evidence://benchmarks/large-instruct-cold-start",
    },
    dataPolicy: {
      allowedDataClasses: ["public", "internal", "confidential"],
      externalProcessing: "forbidden",
    },
    knownLimitations: ["Quality and throughput claims require exact-profile certification."],
    validationEvidence: [{
      stage: "discovery",
      result: "passed",
      runId: "model-discovery-0001",
      evidenceRef: "evidence://models/model-discovery-0001",
      observedAt: "2026-08-11T08:15:00.000Z",
      environmentDigest: digest("8"),
    }],
    exclusive: true,
    extensions: { scheduler_requirements: { storage_class: "encrypted_nvme" } },
    ...structuredClone(overrides),
  };
}

function setup() {
  const audit = [];
  let counter = 0;
  const service = new ModelProfileRegistrationService({
    repository: new MemoryModelProfileRepository(),
    auditSink: { async record(event) { audit.push(event); } },
    clock: () => new Date("2026-08-11T08:30:00.000Z"),
    idGenerator: () => `00000000-0000-4000-8000-${String(7103 + counter++).padStart(12, "0")}`,
  });
  return { service, audit };
}

function code(expected) {
  return (error) => error instanceof ModelProfileRegistrationError && error.code === expected;
}

test("registers an immutable digest-pinned NVFP4 profile with complete deployment facts", async () => {
  const input = declaration();
  const normalized = validateModelProfileDeclarationV1(input);
  assert.deepEqual(normalized.artifacts.map(({ name }) => name), ["config", "weights"]);
  assert.deepEqual(normalized.apiContracts, ["openai.chat-completions@v1", "openai.responses@v1"]);
  assert.match(modelProfileFingerprintV1(input), /^sha256:[a-f0-9]{64}$/);
  const { service, audit } = setup();
  const registered = await service.register({ context, profile: input, operationKey: "model-register-0001" });
  assert.equal(registered.created, true);
  assert.equal(registered.profile.profileId, "00000000-0000-4000-8000-000000007103");
  assert.equal(registered.profile.certification.state, "experimental");
  assert.deepEqual(registered.profile.certification.evidenceRefs, ["evidence://models/model-discovery-0001"]);
  assert.equal(registered.profile.engine.imageDigest, digest("c"));
  assert.equal(registered.profile.resourceEnvelope.unifiedMemoryBytes, 112 * 1024 ** 3);
  assert.equal("dedicatedVramBytes" in registered.profile.resourceEnvelope, false);
  assert.equal(audit[0].event, "model_profile.registered");
});

test("exact replay is idempotent while every material change requires a new profile key", async () => {
  const { service } = setup();
  const first = await service.register({ context, profile: declaration(), operationKey: "model-register-0002" });
  const replay = await service.register({ context, profile: declaration(), operationKey: "model-register-0002" });
  assert.equal(replay.created, false);
  assert.equal(replay.profile.profileId, first.profile.profileId);
  assert.equal(replay.fingerprint, first.fingerprint);

  const changed = declaration({ artifactDigest: digest("b") });
  await assert.rejects(
    service.register({ context, profile: changed, operationKey: "model-register-0003" }),
    code("model_profile_conflict"),
  );
  changed.profileKey = "llm.spark.nvfp4.r2";
  const next = await service.register({ context, profile: changed, operationKey: "model-register-0004" });
  assert.notEqual(next.profile.profileId, first.profile.profileId);
  assert.notEqual(next.fingerprint, first.fingerprint);
});

test("license, provenance, engine, checksum, and exact NVFP4 recipe gates fail closed", async () => {
  const { service } = setup();
  const cases = [
    (item) => { delete item.source.license; },
    (item) => { item.source.provenance.sourceUri = "https://user:password@models.example.test/model"; },
    (item) => { item.engine.imageDigest = "latest"; },
    (item) => { item.artifactDigest = digest("f"); },
    (item) => { item.quantizationRecipe = null; },
    (item) => { item.quantizationRecipe.scheme = "int4"; },
    (item) => { item.validationEvidence[0].evidenceRef = null; },
    (item) => { item.extensions = "not-an-object"; },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const input = declaration();
    cases[index](input);
    await assert.rejects(
      service.register({ context, profile: input, operationKey: `model-invalid-000${index}` }),
      code("model_profile_invalid"),
    );
  }
});

test("external profiles use provider-contract concurrency without invented physical resources", async () => {
  const external = declaration({
    profileKey: "llm.external.provider.r1",
    executionKind: "external_provider",
    precision: "other",
    quantizationRecipe: {
      scheme: "provider-declared", tool: "provider", toolVersion: "1.0",
      recipeDigest: digest("3"), parametersDigest: digest("4"), calibrationDatasetDigest: null,
    },
    resourceEnvelope: {
      accountingMode: "provider_contract", cpuMillis: 0, unifiedMemoryBytes: 0,
      storageBytes: 0, networkBitsPerSecond: 0, acceleratorUnits: 0,
      codecSessions: 0, evidenceRef: "evidence://providers/contract-1",
    },
    dataPolicy: { allowedDataClasses: ["public"], externalProcessing: "approved_only" },
  });
  const { service } = setup();
  assert.equal((await service.register({ context, profile: external, operationKey: "model-external-001" })).created, true);
  external.resourceEnvelope.unifiedMemoryBytes = 1;
  await assert.rejects(
    service.register({ context, profile: external, operationKey: "model-external-002" }),
    code("model_profile_invalid"),
  );
});

test("registration and reads require model management permission", async () => {
  const { service } = setup();
  await assert.rejects(
    service.register({ context: { ...context, permissions: [] }, profile: declaration(), operationKey: "model-register-0005" }),
    code("model_profile_manager_required"),
  );
  await assert.rejects(
    service.get({ context: { ...context, permissions: [] }, profileKey: "llm.spark.nvfp4.r1" }),
    code("model_profile_manager_required"),
  );
});

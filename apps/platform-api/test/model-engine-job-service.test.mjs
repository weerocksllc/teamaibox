import assert from "node:assert/strict";
import test from "node:test";

import { MemoryModelEngineJobRepository } from "../src/models/memory-model-engine-job-repository.mjs";
import {
  ModelEngineJobService,
  modelEngineDigest,
  normalizeEngineBuildSpecification,
} from "../src/models/model-engine-job-service.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const admin = { identityId: "00000000-0000-4000-8000-000000007501", permissions: ["model:manage"] };
const worker = { workerId: "worker.spark.build-1", permissions: ["model:build"] };
const sourceDigest = digest("a");
const calibrationDigest = digest("b");
const outputDigest = digest("c");
const image = `registry.example.test/model-builder@${digest("d")}`;
const servingImage = `registry.example.test/model-server@${digest("e")}`;

function runtime() {
  return {
    os: "ubuntu-24.04", architecture: "linux/arm64/v8", cudaVersion: "13.0",
    engine: "tensorrt-llm", engineVersion: "1.2.0",
    framework: "pytorch", frameworkVersion: "2.9.1",
  };
}

function specification(overrides = {}) {
  const parameters = { algorithm: "nvfp4", blockSize: 16, exclude: ["lm_head"] };
  const parametersDigest = modelEngineDigest(parameters);
  const material = {
    kind: "quantize-export", scheme: "nvfp4", tool: "modelopt",
    toolVersion: "0.35.0", parameters, parametersDigest,
    calibrationDatasetDigest: calibrationDigest,
  };
  return {
    buildKey: "qwen.nvfp4.engine.r1", candidateId: "qwen-nvfp4",
    source: { model: "Qwen/example", revision: "revision-123", artifactDigest: sourceDigest },
    builder: { image, entrypointDigest: digest("f") }, runtime: runtime(),
    recipe: { ...material, recipeDigest: modelEngineDigest(material) },
    outputs: [{ name: "engine", role: "engine", mediaType: "application/vnd.nvidia.trtllm.engine" }],
    environment: { networkMode: "none", sourceDateEpoch: 1_700_000_000, locale: "C.UTF-8", timezone: "UTC" },
    resources: { exclusive: true, cpuMillis: 8000, unifiedMemoryBytes: 96 * 1024 ** 3, storageBytes: 40 * 1024 ** 3 },
    ...overrides,
  };
}

function fixture() {
  const clock = () => new Date("2026-08-11T11:00:00.000Z");
  const artifacts = new Map([
    [sourceDigest, { digest: sourceDigest, sizeBytes: 100, state: "ready", candidateId: "qwen-nvfp4", sourceRevision: "revision-123" }],
    [calibrationDigest, { digest: calibrationDigest, sizeBytes: 20, state: "ready" }],
  ]);
  const repository = new MemoryModelEngineJobRepository({
    clock,
    idFactory: (() => { let sequence = 0; return () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`; })(),
  });
  const audit = [];
  const service = new ModelEngineJobService({
    repository,
    artifactCatalog: { async getArtifact(value) { return artifacts.get(value) ?? null; } },
    clock,
    audit: async (event) => audit.push(event),
  });
  return { artifacts, audit, repository, service };
}

function resultFor(job) {
  return {
    specificationFingerprint: job.fingerprint, builderImage: image, runtime: runtime(),
    recipeDigest: job.specification.recipe.recipeDigest,
    parametersDigest: job.specification.recipe.parametersDigest,
    calibrationDatasetDigest: calibrationDigest,
    outputs: [{ name: "engine", role: "engine", mediaType: "application/vnd.nvidia.trtllm.engine", digest: outputDigest, sizeBytes: 80 }],
    provenanceDigest: digest("1"), sbomDigest: digest("2"), logDigest: digest("3"),
    environmentDigest: digest("4"),
    startedAt: "2026-08-11T10:00:00.000Z", finishedAt: "2026-08-11T10:30:00.000Z",
  };
}

test("build specification pins every reproducibility input and deduplicates its fingerprint", async () => {
  const state = fixture();
  const first = await state.service.queueBuild({ admin, context: admin, specification: specification(), operationKey: "model-build-queue-001" });
  assert.equal(first.created, true);
  assert.equal(first.job.state, "queued");
  assert.match(first.job.fingerprint, /^sha256:/);
  assert.equal(first.job.specification.builder.image, image);
  assert.equal(first.job.specification.recipe.calibrationDatasetDigest, calibrationDigest);
  assert.equal(first.job.specification.environment.networkMode, "none");
  assert.equal(first.job.specification.resources.exclusive, true);
  assert.equal("operationKey" in first.job, false);

  const reordered = specification();
  reordered.recipe.parameters = { exclude: ["lm_head"], blockSize: 16, algorithm: "nvfp4" };
  const replay = await state.service.queueBuild({ context: admin, specification: reordered, operationKey: "model-build-queue-002" });
  assert.equal(replay.created, false);
  assert.equal(replay.job.jobId, first.job.jobId);
  assert.equal(state.audit.at(-1).created, false);
});

test("mutable containers, digest drift, network access, secrets, and missing calibration fail closed", async () => {
  const state = fixture();
  const cases = [
    (item) => { item.builder.image = "registry.example.test/model-builder:latest"; },
    (item) => { item.recipe.parameters.blockSize = 32; },
    (item) => { item.recipe.recipeDigest = digest("9"); },
    (item) => { item.recipe.calibrationDatasetDigest = null; },
    (item) => { item.environment.networkMode = "host"; },
    (item) => { item.recipe.parameters.apiToken = "forbidden"; },
    (item) => { item.resources.exclusive = false; },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const input = specification(); cases[index](input);
    await assert.rejects(state.service.queueBuild({
      context: admin, specification: input, operationKey: `model-build-invalid-00${index}`,
    }), (error) => error.code === "model_engine_spec_invalid");
  }
  state.artifacts.delete(calibrationDigest);
  await assert.rejects(state.service.queueBuild({
    context: admin, specification: specification(), operationKey: "model-build-missing-calibration",
  }), (error) => error.code === "model_build_input_unavailable");
});

test("fenced worker completion verifies pinned environment and protected output digests", async () => {
  const state = fixture();
  const queued = await state.service.queueBuild({ context: admin, specification: specification(), operationKey: "model-build-complete-001" });
  const claim = await state.service.claimBuild({ context: worker, jobId: queued.job.jobId });
  assert.match(claim.claimToken, /^[0-9a-f-]{36}$/);
  assert.equal("claim" in claim.job, false);
  const stored = await state.repository.getBuild(queued.job.jobId);

  await assert.rejects(state.service.completeBuild({
    context: worker, jobId: queued.job.jobId, claimToken: "wrong-fence", result: resultFor(stored),
  }), (error) => error.code === "model_engine_job_fenced");
  state.artifacts.set(outputDigest, { digest: outputDigest, sizeBytes: 80, state: "ready" });
  const changed = resultFor(stored); changed.builderImage = `registry.example.test/other@${digest("8")}`;
  await assert.rejects(state.service.completeBuild({
    context: worker, jobId: queued.job.jobId, claimToken: claim.claimToken, result: changed,
  }), (error) => error.code === "model_engine_result_mismatch");
  await assert.rejects(state.service.completeBuild({
    context: worker, jobId: queued.job.jobId, claimToken: "wrong-fence", result: resultFor(stored),
  }), (error) => error.code === "model_engine_job_fenced");
  const completed = await state.service.completeBuild({
    context: worker, jobId: queued.job.jobId, claimToken: claim.claimToken, result: resultFor(stored),
  });
  assert.equal(completed.state, "succeeded");
  assert.equal(completed.result.outputs[0].digest, outputDigest);
  assert.equal(completed.result.provenanceDigest, digest("1"));
});

test("deployment job pins successful build outputs, serving image, runtime, config, and health", async () => {
  const state = fixture();
  const build = await state.service.queueBuild({ context: admin, specification: specification(), operationKey: "model-build-deploy-001" });
  await assert.rejects(state.service.queueDeployment({
    context: admin, buildJobId: build.job.jobId, deployment: {}, operationKey: "model-deploy-too-early",
  }), (error) => error.code === "model_build_not_ready");
  const claim = await state.service.claimBuild({ context: worker, jobId: build.job.jobId });
  state.artifacts.set(outputDigest, { digest: outputDigest, sizeBytes: 80, state: "ready" });
  const stored = await state.repository.getBuild(build.job.jobId);
  await state.service.completeBuild({ context: worker, jobId: build.job.jobId, claimToken: claim.claimToken, result: resultFor(stored) });

  const configuration = { batchSize: 1, maxSequenceLength: 32768 };
  const deployment = {
    deploymentKey: "qwen.nvfp4.spark.r1", servingImage, runtime: runtime(), configuration,
    configurationDigest: modelEngineDigest(configuration),
    target: { architecture: "linux/arm64/v8", acceleratorFamily: "nvidia-blackwell", resourceClass: "spark-large", executionMode: "exclusive" },
    health: { path: "/health/ready", startupTimeoutSeconds: 300, successThreshold: 3 },
  };
  const queued = await state.service.queueDeployment({
    context: admin, buildJobId: build.job.jobId, deployment, operationKey: "model-deployment-queue-001",
  });
  assert.equal(queued.job.specification.outputs[0].digest, outputDigest);
  assert.equal(queued.job.specification.configurationDigest, modelEngineDigest(configuration));
  const deployClaim = await state.service.claimDeployment({ context: worker, jobId: queued.job.jobId });
  const result = {
    specificationFingerprint: queued.job.fingerprint, servingImage, runtime: runtime(),
    configurationDigest: modelEngineDigest(configuration), outputDigests: [outputDigest],
    deploymentManifestDigest: digest("5"), environmentDigest: digest("6"), healthEvidenceDigest: digest("7"),
    startedAt: "2026-08-11T10:31:00.000Z", finishedAt: "2026-08-11T10:35:00.000Z",
  };
  const completed = await state.service.completeDeployment({
    context: worker, jobId: queued.job.jobId, claimToken: deployClaim.claimToken, result,
  });
  assert.equal(completed.state, "succeeded");
  assert.equal(completed.result.deploymentManifestDigest, digest("5"));
});

test("build and deployment administration is not available to personal users", async () => {
  const state = fixture();
  await assert.rejects(state.service.queueBuild({
    context: { permissions: [] }, specification: specification(), operationKey: "model-build-denied-001",
  }), (error) => error.code === "model_manager_required");
  assert.throws(() => normalizeEngineBuildSpecification({}), (error) => error.code === "model_engine_spec_invalid");
});

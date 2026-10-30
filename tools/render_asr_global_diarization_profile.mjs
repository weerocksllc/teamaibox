#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  modelProfileFingerprintV1,
  validateModelProfileDeclarationV1,
} from "../apps/platform-api/src/models/model-profile-registration-service.mjs";

const [sourcePath, diarizationPath, profileId, asrImageDigest, diarizationImageDigest, createdAt] = process.argv.slice(2);
if (![sourcePath, diarizationPath, profileId, asrImageDigest, diarizationImageDigest, createdAt].every(Boolean)) {
  throw new Error("profile arguments are required");
}
const readJson = async (path) => JSON.parse(path === "-"
  ? await new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  })
  : await readFile(path, "utf8"));
const source = await readJson(sourcePath);
const diarizationBytes = await readFile(diarizationPath);
const diarization = JSON.parse(diarizationBytes);
const diarizationProfileDigest = `sha256:${createHash("sha256").update(diarizationBytes).digest("hex")}`;
const profileKey = "asr.whisper-small.ct2-int8.spark-local.sharded-diarization.experimental.a1";
const configurationDigest = `sha256:${createHash("sha256").update(JSON.stringify({
  asrConfigurationDigest: source.engine.configurationDigest,
  diarizationProfile: diarization,
  composition: "global-diarization-prepass-plus-timestamp-attributed-asr-shards",
})).digest("hex")}`;
const artifacts = [...source.artifacts, {
  name: "sortformer-streaming-4spk-q8-weights",
  role: "weights",
  digest: diarization.artifact.sha256,
  sizeBytes: diarization.artifact.sizeBytes,
  mediaType: "application/vnd.gguf",
}];
const declaration = validateModelProfileDeclarationV1({
  profileKey,
  capabilityId: source.capabilityId,
  executionKind: "managed_node",
  source: source.source,
  artifacts,
  artifactDigest: source.artifactDigest,
  engine: {
    ...source.engine,
    version: "1.3.0-sharded-global-diarization.a1",
    imageDigest: asrImageDigest,
    configurationDigest,
  },
  precision: source.precision,
  quantizationRecipe: source.quantizationRecipe,
  compatibility: source.compatibility,
  apiContracts: source.apiContracts,
  limits: {
    ...source.limits,
    maximumInputBytes: 67_108_864,
    maximumDurationSeconds: 604_800,
    maximumConcurrentRequests: 1,
  },
  resourceEnvelope: {
    ...source.resourceEnvelope,
    cpuMillis: Math.max(12_000, source.resourceEnvelope.cpuMillis),
    unifiedMemoryBytes: Math.max(12 * 1024 ** 3, source.resourceEnvelope.unifiedMemoryBytes),
    storageBytes: source.resourceEnvelope.storageBytes + diarization.artifact.sizeBytes,
    acceleratorUnits: 1,
    evidenceRef: "evidence://validation/feature-deployments/current-speaker-diarization-worker-20260830-a4",
  },
  coldStart: {
    estimatedMilliseconds: Math.max(60_000, source.coldStart.estimatedMilliseconds),
    artifactReadBytes: source.coldStart.artifactReadBytes + diarization.artifact.sizeBytes,
    evidenceRef: "evidence://validation/feature-deployments/current-speaker-diarization-worker-20260830-a4",
  },
  dataPolicy: source.dataPolicy,
  knownLimitations: [
    "Speaker separation is currently available only for WAV audio and at most four speakers.",
    "The local development route serializes diarization and ASR to avoid unified-memory oversubscription.",
    "The composite profile remains Experimental until release-candidate quality, soak, physical 10GbE, and independent acceptance gates pass.",
  ],
  validationEvidence: [
    {
      runId: "current-asr-long-sharding-20260830-a10", stage: "build", result: "passed",
      environmentDigest: asrImageDigest,
      evidenceRef: "evidence://validation/feature-deployments/current-asr-long-sharding-20260830-a10",
      observedAt: createdAt,
    },
    {
      runId: "current-speaker-diarization-worker-20260830-a4", stage: "smoke", result: "passed",
      environmentDigest: diarizationImageDigest,
      evidenceRef: "evidence://validation/feature-deployments/current-speaker-diarization-worker-20260830-a4",
      observedAt: createdAt,
    },
    {
      runId: "current-asr-two-node-development-20260830-a2", stage: "coexistence_cluster", result: "passed",
      environmentDigest: diarizationImageDigest,
      evidenceRef: "evidence://validation/feature-deployments/current-asr-two-node-development-20260830-a2",
      observedAt: createdAt,
    },
  ],
  exclusive: false,
  extensions: {
    input_kinds: ["audio"],
    served_model: "whisper-small-ct2-int8",
    supports_sharding: true,
    timestamp_granularities: ["segment"],
    speaker_information: true,
    physical_ten_gigabit_qualified: false,
    speaker_attribution: {
      mode: "global_diarization_prepass",
      maximum_speaker_count: diarization.speakerInformation.maximumSpeakerCount,
      profile_key: diarization.profileKey,
      profile_fingerprint: diarizationProfileDigest,
      engine_image_digest: diarizationImageDigest,
      lazy_model_residency: true,
    },
  },
});
const fingerprint = modelProfileFingerprintV1(declaration);
const profileDocument = {
  schemaVersion: 1,
  profileId,
  ...declaration,
  certification: {
    state: "experimental",
    evidenceRefs: declaration.validationEvidence.map((item) => item.evidenceRef),
  },
  createdAt,
};
process.stdout.write(JSON.stringify({ fingerprint, declaration, profileDocument }));

#!/usr/bin/env node
import { createCipheriv, createHash, randomBytes } from "node:crypto";

import { reduceAsrShardTranscripts } from "../services/scheduler/src/asr-shard-planner.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const inputBytes = Buffer.concat(chunks);
let input;
try { input = JSON.parse(inputBytes.toString("utf8")); } finally { inputBytes.fill(0); }
const byIndex = new Map(input.shardResults.map((item) => [item.shardIndex, item]));
const ordered = input.completionOrder.map((index) => byIndex.get(index));
if (ordered.some((item) => item == null)) throw new Error("completion order is incomplete");
const result = reduceAsrShardTranscripts({ plan: input.plan, shardResults: ordered,
  globalDiarization: input.globalDiarization, completedAt: new Date("2026-08-30T00:00:00Z") });
const encoded = Buffer.from(JSON.stringify(result));
const key = randomBytes(32), nonce = randomBytes(12);
let cipherFacts;
try {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const encrypted = Buffer.concat([cipher.update(encoded), cipher.final()]);
  const tag = cipher.getAuthTag();
  cipherFacts = {
    algorithm: "AES-256-GCM", ciphertextSha256: `sha256:${createHash("sha256").update(encrypted).update(tag).digest("hex")}`,
    plaintextSizeBytes: encoded.byteLength, ciphertextSizeBytes: encrypted.byteLength + tag.byteLength,
    authenticationTagBytes: tag.byteLength, keyRetained: false,
  };
  encrypted.fill(0); tag.fill(0);
} finally { key.fill(0); nonce.fill(0); }
const timestampsMonotonic = result.segments.every((segment, index) => index === 0
  || result.segments[index - 1].start_seconds <= segment.start_seconds);
const provenanceComplete = result.segments.every((segment) => segment.provenance?.shard_id
  && segment.provenance?.source_result_sha256 && segment.provenance?.global_diarization_sha256);
const safe = {
  resultSha256: `sha256:${createHash("sha256").update(encoded).digest("hex")}`,
  textSha256: `sha256:${createHash("sha256").update(result.text).digest("hex")}`,
  timestampSha256: `sha256:${createHash("sha256").update(JSON.stringify(result.segments.map((item) => [item.start_seconds, item.end_seconds]))).digest("hex")}`,
  speakerSha256: `sha256:${createHash("sha256").update(JSON.stringify(result.segments.map((item) => item.speaker))).digest("hex")}`,
  segmentCount: result.segments.length,
  speakerCount: result.speaker_information.speaker_count,
  attributionMode: result.speaker_information.attribution_mode,
  timestampsMonotonic,
  segmentProvenanceComplete: provenanceComplete,
  finalShardOrder: input.plan.shards.map((item) => item.shardIndex),
  completionOrder: input.completionOrder,
  encryptedArtifact: cipherFacts,
};
encoded.fill(0);
process.stdout.write(JSON.stringify(safe));

import assert from "node:assert/strict";
import { test } from "node:test";

import { asrCapabilitySnapshotV1 } from "../src/public/capabilities-v1.mjs";

function application(model) {
  return { models: [model] };
}

test("keeps the certified Whisper Small route segment-only", () => {
  assert.deepEqual(asrCapabilitySnapshotV1(application({
    capabilityKey: "asr", available: true, routingClass: "certified",
    certifiedProfiles: ["asr.whisper-small.ct2-int8.spark-local.realtime.v1"],
  })), {
    experimental: false,
    wordTimestamps: false,
    speakerInformation: false,
    selectedProfile: null,
    profiles: ["asr.whisper-small.ct2-int8.spark-local.realtime.v1"],
  });
});

test("enables word timestamps only for an explicitly qualified active profile", () => {
  assert.deepEqual(asrCapabilitySnapshotV1(application({
    capabilityKey: "asr", available: true, routingClass: "experimental",
    experimentalProfiles: ["asr.whisper-large-v3.fp16.spark-worker02.audio.v2"],
  })), {
    experimental: true,
    wordTimestamps: true,
    speakerInformation: false,
    selectedProfile: null,
    profiles: ["asr.whisper-large-v3.fp16.spark-worker02.audio.v2"],
  });
});

test("enables speaker information only for the exact selected composite profile", () => {
  assert.deepEqual(asrCapabilitySnapshotV1(application({
    capabilityKey: "asr", available: true, routingClass: "certified",
    certifiedProfiles: ["asr.whisper-small.ct2-int8.spark-local.realtime.v1"],
    experimentalProfiles: ["asr.whisper-small.ct2-int8.spark-local.sharded-diarization.experimental.a1"],
    selectedProfile: "asr.whisper-small.ct2-int8.spark-local.sharded-diarization.experimental.a1",
    selectedCertificationState: "experimental",
  })), {
    experimental: true,
    wordTimestamps: false,
    speakerInformation: true,
    selectedProfile: "asr.whisper-small.ct2-int8.spark-local.sharded-diarization.experimental.a1",
    profiles: ["asr.whisper-small.ct2-int8.spark-local.realtime.v1"],
  });
});

test("fails closed for unavailable, unknown, and mixed routes", () => {
  assert.equal(asrCapabilitySnapshotV1(null).wordTimestamps, false);
  assert.equal(asrCapabilitySnapshotV1(application({ capabilityKey: "asr", available: false,
    routingClass: "certified", certifiedProfiles: ["asr.whisper-large-v3.fp16.spark-worker02.audio.v2"] })).wordTimestamps, false);
  assert.equal(asrCapabilitySnapshotV1(application({ capabilityKey: "asr", available: true,
    routingClass: "certified", certifiedProfiles: ["asr.whisper-large-v3.fp16.spark-worker02.audio.v2", "asr.unknown"] })).wordTimestamps, false);
});

#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? null : process.argv[index + 1];
}

const baseUrl = argument("base-url");
const audioPath = argument("audio");
if (!/^http:\/\/[a-z0-9-]{3,80}:8080$/.test(baseUrl ?? "")) throw new Error("base URL is invalid");
if (!/^\/validation\/[a-z0-9._-]{3,80}\.wav$/.test(audioPath ?? "")) throw new Error("audio path is invalid");

const bytes = await readFile(audioPath);
if (bytes.length < 1024 || bytes.length > 32 * 1024 * 1024) throw new Error("audio fixture size is invalid");
const readyStarted = performance.now();
let ready = null;
for (let attempt = 0; attempt < 300; attempt += 1) {
  try {
    const response = await fetch(`${baseUrl}/health/ready`, { signal: AbortSignal.timeout(1000) });
    const value = await response.json();
    if (response.ok && value?.status === "ready" && value?.model === "whisper-large-v3-fp16"
        && value?.device === "cuda" && value?.precision === "fp16") {
      ready = value;
      break;
    }
  } catch {
    // The model container may still be loading the verified checkpoint.
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
if (!ready) throw new Error("ASR worker did not become ready within the bounded window");
const readinessMilliseconds = Math.round((performance.now() - readyStarted) * 1000) / 1000;
const form = new FormData();
form.set("file", new Blob([bytes], { type: "audio/wav" }), "qualification.wav");
form.set("model", "whisper-large-v3-fp16");
form.set("language", "en");
form.set("response_format", "verbose_json");
form.append("timestamp_granularities[]", "segment");
form.set("temperature", "0");

const started = performance.now();
const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
  method: "POST",
  body: form,
  signal: AbortSignal.timeout(10 * 60 * 1000),
});
const latencyMilliseconds = Math.round((performance.now() - started) * 1000) / 1000;
const value = await response.json();
if (!response.ok || typeof value?.text !== "string" || !Array.isArray(value?.segments)) {
  throw new Error(`ASR request failed with HTTP ${response.status}`);
}
const normalized = value.text.toLowerCase().match(/[a-z]+/g) ?? [];
const expected = ["team", "ai", "box", "distributed", "speech", "transcription", "test"];
const observed = new Set(normalized);
const wordMatchRatio = expected.filter((word) => observed.has(word)).length / expected.length;
const timestampMonotonic = value.segments.every((segment, index, values) => (
  Number.isFinite(segment?.start)
  && Number.isFinite(segment?.end)
  && segment.start >= 0
  && segment.end >= segment.start
  && (index === 0 || segment.start >= values[index - 1].start)
));
const passed = response.status === 200
  && value.language === "en"
  && value.segments.length > 0
  && timestampMonotonic
  && wordMatchRatio >= 0.6;

const digest = (input) => `sha256:${createHash("sha256").update(input).digest("hex")}`;
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  passed,
  operation: "openai.audio-transcriptions.create",
  status: response.status,
  model: "whisper-large-v3-fp16",
  language: value.language,
  durationSeconds: value.duration,
  segmentCount: value.segments.length,
  timestampMonotonic,
  wordMatchRatio,
  latencyMilliseconds,
  readinessMilliseconds,
  resultDigest: digest(value.text),
  resultBytes: Buffer.byteLength(value.text),
  inputArtifactDigest: digest(bytes),
  retainedAudioOrTranscriptContent: false,
}, null, 0)}\n`);
process.exitCode = passed ? 0 : 1;

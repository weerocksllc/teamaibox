import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { OpenAiRealtimeSpeechTransport } from "../server/realtime-speech-transport.mjs";

async function worker(responseFactory) {
  const calls = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      calls.push({ method: request.method, url: request.url, headers: request.headers, body });
      const result = responseFactory?.({ request, body }) ?? {
        status: 200,
        body: {
          text: "Team AI Box realtime speech.", language: "en", duration: 1.25,
          segments: [{ id: 0, start: 0, end: 1.25, text: "Team AI Box realtime speech." }],
        },
      };
      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, calls, origin: `http://127.0.0.1:${server.address().port}` };
}

test("OpenAI realtime speech transport sends a bounded multipart request and validates the transcript", async (t) => {
  const upstream = await worker();
  t.after(() => upstream.server.close());
  const transport = new OpenAiRealtimeSpeechTransport({
    origin: upstream.origin,
    model: "whisper-small-int8",
    maximumChunkBytes: 1024 * 1024,
  });
  const audio = Buffer.alloc(128, 0x2a);
  const result = await transport.transcribe({ audio, contentType: "audio/wav", language: "en" });
  assert.equal(result.text, "Team AI Box realtime speech.");
  assert.equal(result.segments.length, 1);
  assert.equal(upstream.calls.length, 1);
  const call = upstream.calls[0];
  assert.equal(call.method, "POST");
  assert.equal(call.url, "/v1/audio/transcriptions");
  assert.match(call.headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.match(call.body.toString("latin1"), /name="model"\r\n\r\nwhisper-small-int8/);
  assert.match(call.body.toString("latin1"), /name="language"\r\n\r\nen/);
  assert.equal(call.body.includes(audio), true);
  assert.equal(audio.every((value) => value === 0x2a), true);
  transport.close();
});

test("OpenAI realtime speech transport maps worker failures without retaining response content", async (t) => {
  const upstream = await worker(() => ({ status: 503, body: { error: { message: "private worker detail" } } }));
  t.after(() => upstream.server.close());
  const transport = new OpenAiRealtimeSpeechTransport({
    origin: upstream.origin,
    model: "whisper-small-int8",
    maximumChunkBytes: 1024 * 1024,
  });
  await assert.rejects(
    transport.transcribe({ audio: Buffer.alloc(128), contentType: "audio/wav" }),
    (error) => error.code === "realtime_worker_unavailable"
      && error.retryable === true
      && !JSON.stringify(error).includes("private worker detail"),
  );
  transport.close();
});

test("OpenAI realtime speech transport rejects public plain-HTTP workers and oversized chunks", async () => {
  assert.throws(() => new OpenAiRealtimeSpeechTransport({
    origin: "http://10.64.0.23:8080",
    model: "whisper-small-int8",
  }), /private container service name/);
  const transport = new OpenAiRealtimeSpeechTransport({
    origin: "http://realtime-asr-worker:8080",
    model: "whisper-small-int8",
    maximumChunkBytes: 1024,
  });
  await assert.rejects(
    transport.transcribe({ audio: Buffer.alloc(1025), contentType: "audio/wav" }),
    (error) => error.code === "realtime_audio_invalid",
  );
  transport.close();
});

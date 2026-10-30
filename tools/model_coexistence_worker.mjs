#!/usr/bin/env node
import { createHash } from "node:crypto";
import http from "node:http";
import { Worker } from "node:worker_threads";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const capability = process.env.CAPABILITY ?? "";
const memoryTouchBytes = Number(process.env.MEMORY_TOUCH_BYTES ?? "0");
const cpuStressWorkers = Number(process.env.CPU_STRESS_WORKERS ?? "0");

if (!/^[a-z][a-z0-9-]{1,63}$/.test(capability)) throw new Error("CAPABILITY is invalid");
if (!Number.isSafeInteger(memoryTouchBytes) || memoryTouchBytes < MIB || memoryTouchBytes > 64 * GIB) {
  throw new Error("MEMORY_TOUCH_BYTES is invalid");
}
if (!Number.isSafeInteger(cpuStressWorkers) || cpuStressWorkers < 0 || cpuStressWorkers > 8) {
  throw new Error("CPU_STRESS_WORKERS is invalid");
}

const chunks = [];
const chunkBytes = 64 * MIB;
let remaining = memoryTouchBytes;
while (remaining > 0) {
  const size = Math.min(chunkBytes, remaining);
  const chunk = Buffer.allocUnsafe(size);
  chunk.fill(0xa5);
  chunks.push(chunk);
  remaining -= size;
}

const stressors = [];
const stressSource = `
  const { parentPort } = require("node:worker_threads");
  let value = 0x9e3779b9;
  while (true) {
    for (let i = 0; i < 2000000; i += 1) {
      value = Math.imul(value ^ (value >>> 16), 0x45d9f3b) >>> 0;
    }
    if ((value & 0xfffff) === 0) parentPort.postMessage(value);
  }
`;
for (let index = 0; index < cpuStressWorkers; index += 1) {
  const worker = new Worker(stressSource, { eval: true });
  worker.on("message", () => {});
  stressors.push(worker);
}

let sequence = 0;
let shuttingDown = false;
const startedAt = new Date().toISOString();
const server = http.createServer((request, response) => {
  const send = (status, document) => {
    const body = JSON.stringify(document);
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
    });
    response.end(body);
  };
  if (request.method === "GET" && request.url === "/health/ready") {
    send(shuttingDown ? 503 : 200, {
      ready: !shuttingDown,
      capability,
      startedAt,
      memoryTouchBytes,
      cpuStressWorkers,
    });
    return;
  }
  if (request.method === "POST" && request.url === "/work") {
    sequence += 1;
    const digest = createHash("sha256").update(`${capability}:${sequence}`).digest("hex");
    const chunk = chunks[sequence % chunks.length];
    for (let offset = sequence % 4096; offset < chunk.length; offset += 1024 * 1024) chunk[offset] ^= 1;
    send(200, { capability, sequence, resultDigest: `sha256:${digest}` });
    return;
  }
  send(404, { error: "not_found" });
});

const keepResident = setInterval(() => {
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const offset = (sequence + index * 4096) % chunk.length;
    chunk[offset] ^= 1;
  }
}, 10_000);
keepResident.unref();

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(keepResident);
  server.close(async () => {
    await Promise.all(stressors.map((worker) => worker.terminate()));
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
server.listen(8080, "0.0.0.0", () => {
  process.stdout.write(`${JSON.stringify({ event: "coexistence_worker_ready", capability, memoryTouchBytes, cpuStressWorkers })}\n`);
});

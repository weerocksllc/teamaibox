import { isMainThread, parentPort, Worker } from "node:worker_threads";

const workerCount = 4;
const bytesPerWorker = 128 * 2 ** 20;

if (!isMainThread) {
  const chunks = [];
  for (let allocated = 0; allocated < bytesPerWorker; allocated += 8 * 2 ** 20) {
    const chunk = Buffer.allocUnsafe(8 * 2 ** 20);
    chunk.fill((allocated / (8 * 2 ** 20)) & 0xff);
    chunks.push(chunk);
  }
  parentPort.postMessage({ ready: true, bytes: bytesPerWorker });
  let value = 1;
  while (true) {
    value = (value * 48271) % 0x7fffffff;
    if (value === 0) process.exit(1);
  }
} else {
  let ready = 0;
  for (let index = 0; index < workerCount; index += 1) {
    const worker = new Worker(new URL(import.meta.url));
    worker.on("message", (message) => {
      if (message?.ready !== true) return;
      ready += 1;
      if (ready === workerCount) {
        process.stdout.write(JSON.stringify({
          event: "ai_saturation_ready",
          workers: workerCount,
          touchedBytes: workerCount * bytesPerWorker,
        }) + "\n");
      }
    });
    worker.on("error", (error) => {
      process.stderr.write(JSON.stringify({ event: "worker_error", name: error.name }) + "\n");
      process.exit(1);
    });
  }
  setInterval(() => {}, 60_000);
}

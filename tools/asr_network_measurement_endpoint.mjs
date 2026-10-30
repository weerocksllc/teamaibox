#!/usr/bin/env node
import net from "node:net";
import process from "node:process";

const MAX_HEADER_BYTES = 4096;
const CHUNK_BYTES = 1024 * 1024;
const ZERO_CHUNK = Buffer.alloc(CHUNK_BYTES);

function integer(value, label, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return parsed;
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(ordered.length * fraction) - 1);
  return ordered[index];
}

function connect(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setNoDelay(true);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function readLine(socket) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > MAX_HEADER_BYTES) {
        cleanup();
        reject(new Error("response header is too large"));
        return;
      }
      const newline = buffered.indexOf(10);
      if (newline === -1) return;
      cleanup();
      resolve(buffered.subarray(0, newline).toString("utf8"));
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onEnd = () => { cleanup(); reject(new Error("connection ended before response")); };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

async function writeZeros(socket, bytes) {
  let remaining = bytes;
  while (remaining > 0) {
    const size = Math.min(remaining, ZERO_CHUNK.length);
    if (!socket.write(size === ZERO_CHUNK.length ? ZERO_CHUNK : ZERO_CHUNK.subarray(0, size))) {
      await new Promise((resolve, reject) => {
        socket.once("drain", resolve);
        socket.once("error", reject);
      });
    }
    remaining -= size;
  }
}

function serveConnection(socket) {
  socket.setNoDelay(true);
  // Protocol errors are connection-scoped.  Never let a malformed or reset
  // client terminate the long-running measurement server.
  socket.on("error", () => {});
  let header = Buffer.alloc(0);
  let mode = null;
  let remaining = 0;
  socket.on("data", async (chunk) => {
    if (mode === "upload") {
      remaining -= chunk.length;
      if (remaining <= 0) {
        socket.end('{"ok":true}\n');
      }
      return;
    }
    if (mode !== null) return;
    header = Buffer.concat([header, chunk]);
    const newline = header.indexOf(10);
    if (newline === -1) {
      if (header.length > MAX_HEADER_BYTES) socket.destroy(new Error("request header is too large"));
      return;
    }
    if (newline > MAX_HEADER_BYTES) {
      socket.destroy(new Error("request header is too large"));
      return;
    }
    let request;
    try {
      request = JSON.parse(header.subarray(0, newline).toString("utf8"));
    } catch {
      socket.destroy(new Error("request header is invalid"));
      return;
    }
    const rest = header.subarray(newline + 1);
    if (request.mode === "ping" && Number.isSafeInteger(request.nonce)) {
      mode = "ping";
      socket.end(JSON.stringify({ ok: true, nonce: request.nonce }) + "\n");
      return;
    }
    if (!Number.isSafeInteger(request.bytes) || request.bytes < 1 || request.bytes > 512 * 1024 * 1024) {
      socket.destroy(new Error("request byte count is invalid"));
      return;
    }
    mode = request.mode;
    if (mode === "upload") {
      remaining = request.bytes - rest.length;
      if (remaining <= 0) socket.end('{"ok":true}\n');
      return;
    }
    if (mode === "download") {
      try {
        await writeZeros(socket, request.bytes);
        socket.end();
      } catch (error) {
        socket.destroy(error);
      }
      return;
    }
    socket.destroy(new Error("request mode is invalid"));
  });
}

async function runServer(host, portValue) {
  if (net.isIP(host) === 0) throw new Error("bind host is invalid");
  const port = integer(portValue, "port", 0, 65535);
  const server = net.createServer(serveConnection);
  server.on("error", (error) => {
    process.stderr.write(`measurement server failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  await new Promise((resolve) => server.listen({ host, port }, resolve));
  const address = server.address();
  process.stdout.write(JSON.stringify({ ready: true, port: address.port }) + "\n");
}

async function ping(host, port, nonce) {
  const socket = await connect(host, port);
  const started = process.hrtime.bigint();
  socket.write(JSON.stringify({ mode: "ping", nonce }) + "\n");
  const response = JSON.parse(await readLine(socket));
  socket.destroy();
  if (response.ok !== true || response.nonce !== nonce) throw new Error("ping response is invalid");
  return Number(process.hrtime.bigint() - started) / 1e6;
}

async function upload(host, port, bytes) {
  const socket = await connect(host, port);
  const started = process.hrtime.bigint();
  socket.write(JSON.stringify({ mode: "upload", bytes }) + "\n");
  await writeZeros(socket, bytes);
  const response = JSON.parse(await readLine(socket));
  socket.destroy();
  if (response.ok !== true) throw new Error("upload response is invalid");
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  return Math.floor((bytes * 8) / seconds);
}

async function download(host, port, bytes) {
  const socket = await connect(host, port);
  let received = 0;
  const started = process.hrtime.bigint();
  socket.write(JSON.stringify({ mode: "download", bytes }) + "\n");
  await new Promise((resolve, reject) => {
    socket.on("data", (chunk) => { received += chunk.length; });
    socket.once("end", resolve);
    socket.once("error", reject);
  });
  if (received !== bytes) throw new Error("download byte count is invalid");
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  return Math.floor((bytes * 8) / seconds);
}

async function runClient(host, portValue, byteValue, throughputValue, latencyValue) {
  if (!/^[A-Za-z0-9_.:-]{1,255}$/.test(host)) throw new Error("host is invalid");
  const port = integer(portValue, "port", 1024, 65535);
  const bytes = integer(byteValue, "sample bytes", 1024, 512 * 1024 * 1024);
  const throughputSamples = integer(throughputValue, "throughput samples", 1, 50);
  const latencySamples = integer(latencyValue, "latency samples", 1, 200);
  const rtt = [];
  const uploads = [];
  const downloads = [];
  for (let index = 0; index < latencySamples; index += 1) rtt.push(await ping(host, port, index));
  for (let index = 0; index < throughputSamples; index += 1) uploads.push(await upload(host, port, bytes));
  for (let index = 0; index < throughputSamples; index += 1) downloads.push(await download(host, port, bytes));
  process.stdout.write(JSON.stringify({
    sampleBytes: bytes,
    throughputSampleCount: throughputSamples,
    latencySampleCount: latencySamples,
    uploadBitsPerSecondP25: percentile(uploads, 0.25),
    downloadBitsPerSecondP25: percentile(downloads, 0.25),
    roundTripLatencyMillisecondsP95: percentile(rtt, 0.95),
    samples: { uploadBitsPerSecond: uploads, downloadBitsPerSecond: downloads, roundTripLatencyMilliseconds: rtt },
  }) + "\n");
}

const [mode, ...args] = process.argv.slice(2);
try {
  if (mode === "server" && args.length === 2) await runServer(...args);
  else if (mode === "client" && args.length === 5) await runClient(...args);
  else throw new Error("usage: endpoint.mjs server BIND_HOST PORT | client HOST PORT BYTES THROUGHPUT_SAMPLES LATENCY_SAMPLES");
} catch (error) {
  process.stderr.write(`measurement endpoint failed: ${error.message}\n`);
  process.exitCode = 1;
}

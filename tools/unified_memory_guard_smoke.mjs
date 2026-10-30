import { readFileSync } from "node:fs";

import { evaluateUnifiedMemoryPressure } from "../services/scheduler/src/unified-memory-guard.mjs";

function keyValues(source, separator = ":") {
  const result = {};
  for (const line of source.trim().split("\n")) {
    const [key, raw = ""] = line.split(separator, 2);
    result[key.trim()] = raw.trim();
  }
  return result;
}

function meminfo() {
  const values = keyValues(readFileSync("/proc/meminfo", "utf8"));
  const bytes = (key) => Number.parseInt(values[key], 10) * 1024;
  return { totalBytes: bytes("MemTotal"), availableBytes: bytes("MemAvailable") };
}

function cgroup() {
  const integer = (name) => Number.parseInt(readFileSync(`/sys/fs/cgroup/${name}`, "utf8"), 10);
  const maximumRaw = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
  const events = keyValues(readFileSync("/sys/fs/cgroup/memory.events", "utf8"), " ");
  return {
    currentBytes: integer("memory.current"),
    maximumBytes: maximumRaw === "max" ? "max" : Number.parseInt(maximumRaw, 10),
    events: {
      high: Number(events.high ?? 0),
      max: Number(events.max ?? 0),
      oom: Number(events.oom ?? 0),
      oomKill: Number(events.oom_kill ?? 0),
      oomGroupKill: Number(events.oom_group_kill ?? 0),
    },
  };
}

function residentBytes() {
  const status = readFileSync("/proc/self/status", "utf8");
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
  if (!match) throw new Error("process RSS unavailable");
  return Number(match[1]) * 1024;
}

function pressure() {
  const source = readFileSync("/proc/pressure/memory", "utf8");
  const result = {};
  for (const line of source.trim().split("\n")) {
    const [kind, ...fields] = line.split(/\s+/);
    result[kind] = Object.fromEntries(fields.map((field) => {
      const [key, value] = field.split("=", 2);
      return [key, Number(value)];
    }));
  }
  return { someAverage10: result.some?.avg10 ?? 0, fullAverage10: result.full?.avg10 ?? 0 };
}

const blocks = [];
for (let index = 0; index < 4; index += 1) blocks.push(Buffer.alloc(16 * 2 ** 20, index + 1));
const observedAt = new Date();
const host = meminfo();
const workerCgroup = cgroup();
const base = {
  nodeId: "00000000-0000-4000-8000-000000000a01",
  observedAt,
  host: { observedAt, ...host, pressure: pressure() },
  driver: {
    observedAt,
    acceleratorUtilizationPercent: null,
    dedicatedMemory: { status: "unsupported", reasonCode: "driver_metric_not_reported" },
  },
  workers: [{
    workerId: "00000000-0000-4000-8000-000000000a02",
    observedAt,
    lifecycleState: "ready",
    activeAttemptCount: 0,
    cgroup: workerCgroup,
    process: { residentBytes: residentBytes() },
    engine: {
      allocatedBytes: 32 * 2 ** 20,
      modelBytes: 24 * 2 ** 20,
      cacheBytes: 8 * 2 ** 20,
      certifiedEnvelopeBytes: 96 * 2 ** 20,
    },
    runtime: { oomKilled: false },
  }],
  activeReservations: [{
    reservationId: "00000000-0000-4000-8000-000000000a03",
    workerId: "00000000-0000-4000-8000-000000000a02",
    unifiedMemoryBytes: 96 * 2 ** 20,
  }],
  controlPlaneFloorBytes: 8 * 2 ** 20,
  workload: { class: "batch", requestedBytes: 16 * 2 ** 20, coldLoad: false },
};
const memoryPolicy = {
  coreServiceFloorBytes: 8 * 2 ** 20,
  emergencyHeadroomBytes: 8 * 2 ** 20,
};
const admitted = evaluateUnifiedMemoryPressure(base, { memoryPolicy });
const denied = evaluateUnifiedMemoryPressure({
  ...base,
  workload: { class: "batch", requestedBytes: host.availableBytes, coldLoad: true },
}, { memoryPolicy });
if (!admitted.admission.allowed
    || denied.admission.allowed
    || !denied.reasons.some((item) => item.code === "unified_memory_insufficient")
    || admitted.dedicatedVram.status !== "unavailable"
    || workerCgroup.maximumBytes === "max"
    || blocks.length !== 4) {
  throw new Error("unified memory guard smoke failed");
}
process.stdout.write(JSON.stringify({
  passed: true,
  cgroupLimitBytes: workerCgroup.maximumBytes,
  cgroupCurrentBytes: workerCgroup.currentBytes,
  processResidentBytes: residentBytes(),
  hostTotalBytes: host.totalBytes,
  dedicatedVramStatus: admitted.dedicatedVram.status,
  denialReason: "unified_memory_insufficient",
}) + "\n");

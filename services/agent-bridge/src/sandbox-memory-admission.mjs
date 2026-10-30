// MemAvailable already excludes resident memory. Charge only the unused part
// of each running sandbox's hard limit, plus the new sandbox and host margin.
const GiB = 1024 ** 3;
const bytes = v => Number.isSafeInteger(v) && v >= 0;
export function sandboxMemoryAdmission({availableBytes, requestedBytes,
  marginBytes = 16 * GiB, running = []}) {
  if (![availableBytes, requestedBytes, marginBytes].every(bytes) || !requestedBytes
      || !Array.isArray(running)) throw Error('agent_memory_telemetry_invalid');
  let unrealizedBytes = 0;
  for (const row of running) {
    if (![row.limitBytes, row.usageBytes, row.reclaimableBytes].every(bytes)
        || !row.limitBytes || row.reclaimableBytes > row.usageBytes)
      throw Error('agent_memory_telemetry_invalid');
    // Reclaimable cache is also included in MemAvailable: it is not already
    // charged resident memory and must not shrink the outstanding commitment.
    const resident = Math.min(row.limitBytes, row.usageBytes - row.reclaimableBytes);
    unrealizedBytes += row.limitBytes - resident;
  }
  if (!bytes(unrealizedBytes)) throw Error('agent_memory_telemetry_invalid');
  const remainingBytes = availableBytes - unrealizedBytes - requestedBytes;
  return {eligible: remainingBytes >= marginBytes, remainingBytes, marginBytes, unrealizedBytes};
}

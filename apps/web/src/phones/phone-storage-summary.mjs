// Storage observations are snapshots, not a promise that another phone fits.
// Admission still uses the node's fresh, authenticated pool observation.
export function phoneStoragePools(pools, nodeId) {
  if (!Array.isArray(pools)) return [];
  return pools.filter(pool => pool?.nodeId === nodeId && pool.lifecycleState === 'active'
    && pool.encryptionMode === 'luks2' && pool.encryptionStatus === 'verified'
    && Array.isArray(pool.dataClasses) && pool.dataClasses.includes('phone-data'))
    .map(pool => {
      const total = pool.totalBytes, free = pool.availableBytes, reserve = pool.safetyReserveBytes;
      const valid = Number.isSafeInteger(total) && total > 0 && Number.isSafeInteger(free) && free >= 0 && free <= total
        && Number.isSafeInteger(reserve) && reserve >= 0 && reserve < total;
      return { poolId: pool.poolId, totalBytes: valid ? total : null, availableBytes: valid ? free : null,
        reserveBytes: valid ? reserve : null,
        observedAt: typeof pool.observedAt === 'string' && Number.isFinite(Date.parse(pool.observedAt)) ? pool.observedAt : null };
    });
}

export function storageGiB(value, locale) {
  return Number.isSafeInteger(value) && value >= 0
    ? `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value / 2 ** 30)} GiB` : '—';
}

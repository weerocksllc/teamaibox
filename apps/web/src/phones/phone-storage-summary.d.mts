export type PhoneStorageSummary = { poolId: string; totalBytes: number | null; availableBytes: number | null; reserveBytes: number | null; observedAt: string | null };
export function phoneStoragePools(pools: unknown, nodeId: string): PhoneStorageSummary[];
export function storageGiB(value: number | null, locale: string): string;

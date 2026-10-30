export type PhoneQuota = {
  ownerId: string; loginName: string; displayName: string; status: string;
  storedPerUser: number | null; runningPerUser: number | null; stored: number; running: number; revision: number;
};
export type PhoneAdministration = {
  policy: { enabled: boolean; revision: number; storedPerUser: number | null; runningPerUser: number | null };
  deploymentReady: boolean; contentAccessGranted: false;
  roms?: Array<{ id: string; familyId: string; name: string; version: string; googlePlay: boolean; experimental: boolean;
    cameraCapability: string; createEnabled: boolean; reasonCode: string | null }>;
  nodes: Array<{ nodeId: string; running: number; reasonCode: string | null;
    nodeName?: string | null; address?: string | null; runningCount?: number | null; startingCount?: number | null;
    observedAt?: string | null; lastSeenAt?: string | null }>;
};
export type PhoneQuotaPage = { data: PhoneQuota[]; nextCursor: string | null };
export class PhoneAdministrationError extends Error {
  constructor(public code: string, public status = 502) { super(code); }
}
function csrfToken() {
  const values = document.cookie.split(";").map(part => part.trim()).filter(part => part.startsWith("__Host-teamaibox-csrf="));
  if (values.length !== 1) throw new PhoneAdministrationError("invalid_session", 401);
  return decodeURIComponent(values[0].slice("__Host-teamaibox-csrf=".length));
}
async function request<T>(path: string, signal: AbortSignal, body?: unknown): Promise<T> {
  const response = await fetch(path, { method: body === undefined ? "GET" : "PUT", credentials: "same-origin",
    cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json", "x-csrf-token": csrfToken() }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const reader = response.body?.getReader();
  if (!reader) throw new PhoneAdministrationError("invalid_response");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 262144) { await reader.cancel(); throw new PhoneAdministrationError("invalid_response"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new PhoneAdministrationError("invalid_response"); }
  if (!response.ok) throw new PhoneAdministrationError(value?.error?.code ?? "request_failed", response.status);
  return value as T;
}
const ROOT = "/api/v1/admin/virtual-phones";
export const loadPhoneAdministration = (signal: AbortSignal) => request<PhoneAdministration>(ROOT, signal);
export const loadPhoneStorage = (signal: AbortSignal) => request<{ pools: unknown[] }>("/api/v1/admin/storage/pools", signal);
export const setPhoneFeature = (enabled: boolean, expectedRevision: number, signal: AbortSignal) =>
  request<PhoneAdministration>(`${ROOT}/feature`, signal, { enabled, expectedRevision });
export function loadPhoneQuotas(search: string, after: string | null, signal: AbortSignal) {
  const query = new URLSearchParams({ search }); if (after) query.set("after", after);
  return request<PhoneQuotaPage>(`${ROOT}/quotas?${query}`, signal);
}
export const savePhoneQuota = (quota: PhoneQuota, signal: AbortSignal) => request(`${ROOT}/quotas/${encodeURIComponent(quota.ownerId)}`, signal,
  { storedPerUser: quota.storedPerUser, runningPerUser: quota.runningPerUser, expectedRevision: quota.revision });
export type PhoneUsbCamera = { deviceId: string; name: string; connected: boolean; enabled: boolean; revision: number; ownerIds: string[] };
export const loadPhoneUsbCameras = (nodeId: string, signal: AbortSignal) =>
  request<{ nodeId: string; data: PhoneUsbCamera[] }>(`${ROOT}/nodes/${encodeURIComponent(nodeId)}/usb-cameras`, signal);
export const savePhoneUsbCamera = (nodeId: string, camera: PhoneUsbCamera, signal: AbortSignal) =>
  request<PhoneUsbCamera>(`${ROOT}/nodes/${encodeURIComponent(nodeId)}/usb-cameras/${encodeURIComponent(camera.deviceId)}`, signal,
    { enabled: camera.enabled, ownerIds: camera.ownerIds, expectedRevision: camera.revision });
export type PhoneNetworkCamera = { id: string; name: string; enabled: boolean; revision: number; ownerIds: string[];
  listenAddress: string; listenPort: number; allowedSources: string[]; externalInputEncrypted: false };
export const loadPhoneNetworkCameras = (nodeId: string, signal: AbortSignal) =>
  request<{ nodeId: string; addresses: string[]; data: PhoneNetworkCamera[] }>(`${ROOT}/nodes/${encodeURIComponent(nodeId)}/network-cameras`, signal);
export const savePhoneNetworkCamera = (nodeId: string, camera: PhoneNetworkCamera, signal: AbortSignal) =>
  request<PhoneNetworkCamera>(`${ROOT}/nodes/${encodeURIComponent(nodeId)}/network-cameras/${encodeURIComponent(camera.id)}`, signal,
    { name: camera.name, enabled: camera.enabled, listenAddress: camera.listenAddress, listenPort: camera.listenPort,
      allowedSources: camera.allowedSources, ownerIds: camera.ownerIds, expectedRevision: camera.revision });

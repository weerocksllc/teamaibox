// Read-only, account-scoped notices. Opening a notice never accepts or joins.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function pendingCastingNotices(value, now = Date.now()) {
  if (value?.object !== 'list' || !Array.isArray(value.data) || value.data.length > 200) throw new Error('cast_notices_invalid');
  const seen = new Set();
  return value.data.flatMap(item => {
    if (item?.object !== 'cast.viewer_invitation' || !UUID.test(item.id ?? '') || !UUID.test(item.sessionId ?? '')
        || !['pending','accepted','declined','expired','revoked'].includes(item.state)
        || !Number.isFinite(Date.parse(item.expiresAt)) || seen.has(item.id)) throw new Error('cast_notices_invalid');
    seen.add(item.id);
    return item.state === 'pending' && Date.parse(item.expiresAt) > now
      ? [Object.freeze({id: item.id, expiresAt: item.expiresAt})] : [];
  });
}
/** @param {{fetchImpl?: typeof fetch, signal?: AbortSignal}} [options] */
export async function loadCastingNotices({fetchImpl = globalThis.fetch, signal} = {}) {
  const response = await fetchImpl('/api/v1/casting/invitations', {
    credentials: 'same-origin', cache: 'no-store', headers: {accept: 'application/json'}, signal,
  });
  if (!response.ok) throw new Error('cast_notices_unavailable');
  return pendingCastingNotices(await response.json());
}

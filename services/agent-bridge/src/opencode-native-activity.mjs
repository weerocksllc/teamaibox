// OpenCode, not platform prompt rows, is the source of truth for native work.
// Unknown state prevents idle reclamation; account disable is handled separately.
export async function nativeInstanceBusy({ request }) {
  try {
    const [statuses, terminals, permissions, questions, nativeV2] = await Promise.all([
      '/session/status', '/pty', '/permission', '/question', '/api/session/active',
    ].map(async path => {
      const response = await request('GET', path, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('native_activity_unavailable');
      return response.json();
    }));
    if (!statuses || typeof statuses !== 'object' || Array.isArray(statuses)
      || !Array.isArray(terminals) || !Array.isArray(permissions) || !Array.isArray(questions)
      || !nativeV2?.data || typeof nativeV2.data !== 'object' || Array.isArray(nativeV2.data)) return true;
    if (Object.keys(nativeV2.data).length) return true;
    if (Object.values(statuses).some(value => !value || value.type !== 'idle')) return true;
    return terminals.some(value => value?.status !== 'exited') || permissions.length > 0 || questions.length > 0;
  } catch { return true; }
}

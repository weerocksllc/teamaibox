const ranks = { viewer: 1, editor: 2, manager: 3, owner: 4 };

export function receivedEntries(records) {
  const entries = new Map();
  for (const { entry, share, access_role } of records) {
    const role = access_role ?? share.role;
    const existing = entries.get(entry.id);
    if (!existing || ranks[role] > ranks[existing.access_role]) {
      entries.set(entry.id, { ...entry, access_role: role, share_id: share.id });
    }
  }
  return [...entries.values()];
}

export function canEditShared(entry) {
  return (ranks[entry?.access_role] ?? 0) >= ranks.editor;
}

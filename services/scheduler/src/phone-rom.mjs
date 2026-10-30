// Stable compatibility identity. An omitted ROM never follows a changing UI default.
export const LEGACY_PHONE_ROM = "aosp-17-16102939-v1";
export const GOOGLE_PHONE_ROM = "google-experimental-17-16102939-v1";
export const PHONE_ROM_ID = /^[a-z][a-z0-9.-]{2,127}$/;

// Configured node mappings are deployment facts, not user-supplied image names.
export function installedPhoneRom(node, romVersionId = LEGACY_PHONE_ROM, imageDigest = null) {
  const selected = node?.roms?.find(rom => rom.romVersionId === romVersionId)
    ?? (romVersionId === LEGACY_PHONE_ROM && !node?.roms ? { romVersionId, imageDigest: node?.imageDigest } : null);
  return selected?.imageDigest && (!imageDigest || selected.imageDigest === imageDigest) ? selected : null;
}

// A host-only repair is scoped to an existing phone, not a new ROM/default.
// Deployment verifies identical Android images before installing this mapping.
// Existing runs retain their exact image; only the next admitted run uses it.
export function installedPhoneRuntime(node, phone, runImageDigest = null) {
  const base = installedPhoneRom(node, phone?.romVersionId, phone?.rom?.imageDigest);
  if (!base) return null;
  const repair = node.runtimeMaintenance?.find(value => value.phoneId === phone.id
    && value.ownerId === phone.ownerId && value.volumeId === phone.volumeId
    && value.romVersionId === phone.romVersionId && value.fromImageDigest === base.imageDigest);
  // The Android system stays pinned to the catalog. A node may install a
  // host-network adapter for that same system, including newly created phones.
  // Existing runs continue to resolve their original exact runtime.
  const imageDigest = runImageDigest ?? repair?.toImageDigest ?? base.runtimeImageDigest ?? base.imageDigest;
  if (imageDigest !== base.imageDigest && imageDigest !== repair?.toImageDigest
      && imageDigest !== base.runtimeImageDigest
      && !repair?.previousImageDigests?.includes(imageDigest)) return null;
  return { ...base, imageDigest };
}

import { LEGACY_PHONE_ROM, GOOGLE_PHONE_ROM, PHONE_ROM_ID } from '../../../../services/scheduler/src/phone-rom.mjs';

const TYPES = Object.freeze([
  { systemId: 'standard', familyId: 'aosp', name: '标准 Android', googlePlay: false },
  { systemId: 'google-play', familyId: 'google-experimental', name: 'Android + Google Play', googlePlay: true },
]);
const LEGACY_RELEASES = Object.freeze({ standard: LEGACY_PHONE_ROM, 'google-play': GOOGLE_PHONE_ROM });

// Publication is explicit, never inferred from a build number or query order.
// The legacy mapping only preserves an existing installation during rollout.
export function phoneSystemReleases(input) {
  if (input === undefined) return null;
  if (!input || Array.isArray(input) || typeof input !== 'object'
    || Object.keys(input).length !== 2 || TYPES.some(t => !Object.hasOwn(input, t.systemId)
      || typeof input[t.systemId] !== 'string' || !PHONE_ROM_ID.test(input[t.systemId]))
    || input.standard === input['google-play']) throw TypeError('Two explicit phone system releases are required');
  return Object.freeze({ ...input });
}

export function phoneSystemReleasesFromEnvironment(environment) {
  const value = environment.PLATFORM_VIRTUAL_PHONE_SYSTEM_RELEASES_JSON;
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw TypeError('Invalid phone system releases');
  return phoneSystemReleases(JSON.parse(value));
}

export function phoneSystemCatalog(roms, releases = null) {
  const selected = releases ?? LEGACY_RELEASES;
  return TYPES.map(type => {
    const matches = roms.filter(rom => rom.id === selected[type.systemId]
      && rom.familyId === type.familyId && rom.googlePlay === type.googlePlay);
    const rom = matches.length === 1 ? matches[0] : null;
    const reasonCode = !rom ? 'phone_rom_unavailable'
      : releases && rom.cameraCapability !== 'verified' ? 'phone_camera_unavailable'
      : rom.reasonCode || (!rom.createEnabled ? 'phone_rom_unavailable' : null);
    return { ...rom, ...type, id: selected[type.systemId], createEnabled: Boolean(rom?.createEnabled && !reasonCode),
      reasonCode, cameraCapability: rom?.cameraCapability ?? 'unavailable', experimental: type.googlePlay || Boolean(rom?.experimental) };
  });
}

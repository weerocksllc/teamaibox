// The ordinary office UI submits the exact main-box profile disclosed by
// the application catalog. Never guess a different or historical profile.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function selectOfficeOcr(catalog) {
  const applications = catalog?.applications;
  if (!Array.isArray(applications)) throw new Error('ocr_profile_unavailable');
  const matches = applications.filter(item => item.pluginKey === 'official.ocr');
  if (matches.length !== 1) throw new Error('ocr_profile_unavailable');
  const application = matches[0];
  const models = application.models?.filter(item => item.capabilityKey === 'ocr');
  if (application.launchable !== true || models?.length !== 1
      || models[0].available !== true || models[0].route !== 'local'
      || !UUID.test(models[0].selectedProfileId ?? '')
      || !/^[a-z][a-z0-9._-]{2,191}$/.test(models[0].selectedProfile ?? '')
      || !Array.isArray(models[0].localRoutableProfiles)
      || !models[0].localRoutableProfiles.includes(models[0].selectedProfile)) {
    throw new Error('ocr_profile_unavailable');
  }
  return Object.freeze({ profileId: models[0].selectedProfileId,
    profileKey: models[0].selectedProfile, model: 'local/ocr-default' });
}

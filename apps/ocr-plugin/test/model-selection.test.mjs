import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { selectOfficeOcr } from '../src/public/model-selection.js';
const OFFICE_OCR = { profileId: 'a0a1906f-8d34-5d30-91f8-990ca2ec3853',
  profileKey: 'ocr.hunyuanocr-1.5.bf16-dflash.main-protected.v1', model: 'local/ocr-default' };

function fixture() {
  return { applications: [{ pluginKey: 'official.ocr', launchable: true, models: [{
    capabilityKey: 'ocr', available: true, route: 'local', selectedProfile: OFFICE_OCR.profileKey,
    selectedProfileId: OFFICE_OCR.profileId,
    localRoutableProfiles: [OFFICE_OCR.profileKey],
  }] }] };
}
test('binds the disclosed resident OCR profile without a model reload', () => {
  assert.deepEqual(selectOfficeOcr(fixture()), OFFICE_OCR);
});
for (const [key, value] of [['available', false], ['route', 'external'],
  ['selectedProfile', 'ocr.old.auxiliary'], ['selectedProfileId', null],
  ['selectedProfileId', 'not-a-uuid'], ['localRoutableProfiles', []]]) {
  test('fails closed when catalog ' + key + ' changes', () => {
    const catalog = fixture(); catalog.applications[0].models[0][key] = value;
    assert.throws(() => selectOfficeOcr(catalog), /ocr_profile_unavailable/);
  });
}
test('rejects unavailable or ambiguous application catalogs', () => {
  const catalog = fixture(); catalog.applications[0].launchable = false;
  assert.throws(() => selectOfficeOcr(catalog));
  assert.throws(() => selectOfficeOcr({}));
  assert.throws(() => selectOfficeOcr({applications:[...fixture().applications,...fixture().applications]}));
});
test('a registered successor is used exactly as disclosed without changing browser code', () => {
  const catalog = fixture(); const m = catalog.applications[0].models[0];
  m.selectedProfile = 'ocr.hunyuanocr.bf16-dflash.main-protected.successor.v2';
  m.selectedProfileId = 'f6ffe978-7a1d-571d-aa6d-d520250dc7a4';
  m.localRoutableProfiles = [OFFICE_OCR.profileKey, m.selectedProfile];
  assert.deepEqual(selectOfficeOcr(catalog), { profileId: m.selectedProfileId,
    profileKey: m.selectedProfile, model: 'local/ocr-default' });
});
test('submission resolves a fresh catalog before upload and includes the exact profile', async () => {
  const source = await readFile(new URL('../src/public/app.js', import.meta.url), 'utf8');
  assert.match(source, /selectOfficeOcr\(await json\("\/api\/v1\/applications"\)\);state.referenceId=await selectedReference\(\)/);
  assert.match(source, /model:selection.model/);
  assert.match(source, /model_profile_id:selection.profileId/);
});

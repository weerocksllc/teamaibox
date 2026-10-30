import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { ApplicationCatalogService } from '../../platform-api/src/applications/application-catalog-service.mjs';
import { localeDefinitions, supportedLocaleCodes } from '../../../packages/ui-system/src/locale-registry.mjs';
import { semanticThemeTokenNamesV1, createPluginPreferenceSnapshotV1 } from '../../../packages/plugin-sdk/src/preferences-v1.mjs';
import { catalogPreferenceManifestV1, catalogPreferenceCompatibilityV1, publishOfficialCatalogPreferencesV1 } from '../src/plugins/catalog-preferences.mjs';

const legacy = { supportedLocales: ['zh-CN', 'en'], fallbackLocale: 'zh-CN', supportedDirections: ['ltr'], rtlReady: false };
const themes = { supported: ['light', 'dark'], usesSemanticTokens: true, livePreferenceEvents: true };
const names = ['assistant', 'messaging', 'team-drive', 'drawing', 'ocr', 'asr', 'translation', 'wireless-casting', 'virtual-phones', 'virtual-computers'];
const apps = names.map(name => ({ pluginKey: `official.${name}`, official: true, localization: legacy, themes }));
const tokens = Object.fromEntries(semanticThemeTokenNamesV1.map(name => [name, '#123456']));

test('old built-in Assistant metadata reproduces the exact Japanese failure before projection', () => {
  assert.throws(() => createPluginPreferenceSnapshotV1({
    manifest: { id: 'official.assistant', official: true, localization: legacy, themes },
    locale: 'ja', direction: 'ltr', theme: 'light', tokenSets: { light: tokens, dark: tokens }, revision: 1,
  }), /official plugin preference compatibility is incomplete/);
});

test('all ten bundled applications accept every product locale and theme even with retained two-language metadata', () => {
  for (const { code: locale, direction } of localeDefinitions) for (const theme of ['light', 'dark']) {
    const dispatched = [], errors = [];
    const snapshots = publishOfficialCatalogPreferencesV1({ applications: apps, locale, direction, theme,
      semanticTokens: tokens, revision: 1, dispatch: (type, snapshot) => dispatched.push(snapshot),
      onError: error => errors.push(error) });
    assert.deepEqual(errors, []);
    assert.equal(snapshots.length, 10); assert.equal(dispatched.length, 10);
    for (const app of apps) {
      const compatibility = catalogPreferenceCompatibilityV1({ app, locale, direction, theme });
      assert.deepEqual(compatibility.effective, { locale, direction, theme });
      assert.deepEqual(compatibility.disclosures, []);
      assert.deepEqual(catalogPreferenceManifestV1(app).localization.supportedLocales, supportedLocaleCodes);
    }
  }
  assert.deepEqual(legacy.supportedLocales, ['zh-CN', 'en']);
});

test('API normalizes retained built-in declarations without changing launch conditions or files', async () => {
  const builtIn = { applicationKey: 'official.assistant', installedVersion: '0.1.0',
    route: { integration: 'workbench', pathPrefix: '/apps/assistant' }, requiredPermissions: ['ai:invoke'],
    requiredCapabilities: [], requiredCoreServices: [], ui: { official: true, localization: legacy, themes } };
  const service = new ApplicationCatalogService({ repository: { async snapshot() { return { plugins: [], capabilities: [], health: [] }; } },
    routeSource: { async routes() { return []; } }, builtInSource: { async applications() { return [builtIn]; } } });
  const [result] = (await service.list({ context: { permissions: ['application:catalog:view', 'ai:invoke'] } })).applications;
  assert.equal(result.launchable, true); assert.equal(result.authorized, true);
  assert.deepEqual(result.ui.localization.supportedLocales, supportedLocaleCodes);
  assert.deepEqual(result.ui.localization.supportedDirections, ['ltr', 'rtl']);
  assert.deepEqual(builtIn.ui.localization, legacy);
  const [denied] = (await service.list({ context: { permissions: ['application:catalog:view'] } })).applications;
  assert.equal(denied.launchable, false); assert.deepEqual(denied.blockers, ['authorization_denied']);
});

test('a malformed application cannot interrupt preference updates for other applications', () => {
  const bad = { ...apps[0], pluginKey: 'official.unrecognized', themes: { ...themes, livePreferenceEvents: false } };
  const errors = [], published = [];
  const snapshots = publishOfficialCatalogPreferencesV1({ applications: [apps[0], bad, apps[7]], locale: 'ja',
    direction: 'ltr', theme: 'dark', semanticTokens: tokens, revision: 2,
    dispatch: (type, snapshot) => published.push(snapshot.pluginId), onError: (error, app) => errors.push(app.pluginKey) });
  assert.deepEqual(published, ['official.assistant', 'official.wireless-casting']);
  assert.equal(snapshots.length, 2); assert.deepEqual(errors, ['official.unrecognized']);
});

test('third-party declarations are not silently expanded', () => {
  const app = { ...apps[0], pluginKey: 'third-party.notes', official: false };
  assert.equal(catalogPreferenceManifestV1(app).localization, legacy);
  const resolved = catalogPreferenceCompatibilityV1({ app, locale: 'ja', direction: 'ltr', theme: 'light' });
  assert.equal(resolved.effective.locale, 'zh-CN');
  assert.equal(resolved.disclosures[0].code, 'locale-fallback');
});

test('new appliance built-in template includes every locale; dynamic workspace contains compatibility failures', async () => {
  const release = JSON.parse(await readFile(new URL('../../../deploy/applications/built-in-applications.v1.json', import.meta.url)));
  assert.deepEqual(release.applications[0].ui.localization.supportedLocales, supportedLocaleCodes);
  const workspace = await readFile(new URL('../src/applications/DynamicApplicationWorkspace.tsx', import.meta.url), 'utf8');
  assert.match(workspace, /catalogPreferenceManifestV1/);
  assert.match(workspace, /if \(!setup\) return/);
  assert.match(workspace, /role="alert"/);
  assert.match(workspace, /initialSource = useRef<string \| null>\(null\)/);
});

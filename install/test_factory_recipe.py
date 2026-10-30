import json
from pathlib import Path
import tempfile
import unittest

from factory_recipe import assemble, emit, installation_steps, readiness
from offline_common import IMAGE_ROLES, PHASES, validate_factory

REPO = Path(__file__).resolve().parents[1]


class RecipeTests(unittest.TestCase):
    def test_complete_recipe_has_unique_owned_services_and_real_adapters(self):
        recipe = assemble(REPO)
        services = recipe['services']['core']
        self.assertEqual(set(services['names']), set(services['roles'].values()))
        self.assertEqual(len(services['roles']), len(services['names']))
        self.assertTrue(set(services['roles']) - {'sfu'} <= IMAGE_ROLES)
        self.assertIn('casting-media', services['names'])
        self.assertIn('desktop-gateway', services['names'])
        self.assertEqual([s['phase'] for s in installation_steps()], list(PHASES))
        self.assertTrue(all(r['role'] in IMAGE_ROLES for r in readiness(recipe)))
        self.assertEqual(next(r for r in readiness(recipe) if r['role'] == 'casting-sfu')['containerRole'], 'sfu')

    def test_emit_materializes_all_templates_and_runtime_dependencies(self):
        with tempfile.TemporaryDirectory() as tmp:
            destination = Path(tmp) / 'factory'
            recipe, runtime = emit(REPO, destination)
            files = {p.name for p in destination.iterdir()}
            validate_factory(recipe, files, runtime)
            self.assertTrue(all('value' not in t for t in recipe['templates']))
            for row in recipe['templates']:
                json.loads((destination / row['input']).read_text())
            for required in ('install/factory_office_ready.mjs', 'install/factory_owner.mjs', 'install/factory_owner.py', 'tools/ai_cache_checkpoint.py',
                             'tools/casting_service_credentials.py', 'tools/appliance_phone_media.py'):
                self.assertIn(required, runtime)
            self.assertNotIn('/home/', json.dumps(recipe))
            self.assertNotIn('factory_foundation.py', runtime)

    def test_desktop_and_dynamic_agent_have_new_local_bindings(self):
        recipe = assemble(REPO)
        compose = next(r['value'] for r in recipe['templates'] if r['output'] == recipe['composeFile'])
        for name in ('desktop-gateway', 'desktop-proxy', 'maintenance-controller'):
            self.assertEqual(compose['services'][name]['network_mode'], 'service:platform-api')
            self.assertNotIn('ports', compose['services'][name])
        self.assertEqual(next(r['value'] for r in recipe['templates'] if r['output'] == 'config/agent-routes.json')['routes'], [])
        self.assertIn('@@INSTALLATION_ID@@', compose['volumes']['factory_agent_state']['name'])
        self.assertEqual(compose['services']['platform-api']['networks']['plugin-ingress'],
                         {'ipv4_address': '@@CASTING.platformAddress@@'})

    def test_fresh_services_match_runtime_startup_contracts(self):
        recipe = assemble(REPO)
        policy = next(r for r in recipe['templates'] if r['output'] == 'public/protected-office-targets.json')
        self.assertEqual((policy['mode'], policy['uid'], policy['gid']), ('0440', 0, 10001))
        compose = next(r['value'] for r in recipe['templates'] if r['output'] == recipe['composeFile'])
        self.assertFalse(compose['services']['casting-media']['init'])
        self.assertEqual(compose['services']['node-agent']['environment']['TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_FILE'],
                         '@@ROOT@@/public/protected-office-targets.json')
        agent = compose['services']['node-agent']
        self.assertEqual(agent['environment']['TEAMAIBOX_PHONE_BASELINE_ENABLED'], 'true')
        self.assertIn(dict(type='bind', source='/proc', target='/host/proc', read_only=True,
                           bind=dict(create_host_path=False)), agent['volumes'])
        self.assertTrue(any(v.get('target') == '@@RUNTIME@@/deploy/android/cuttlefish/phone-seccomp.json'
                            and v.get('read_only') for v in agent['volumes'] if isinstance(v, dict)))
        self.assertTrue(any(v.startswith('seccomp=') for v in compose['services']['casting-media']['security_opt']))
        maintenance = next(r['value'] for r in recipe['templates'] if r['output'] == 'config/maintenance-runtime.json')
        self.assertEqual(maintenance['candidates'], [])

    def test_offline_plugin_and_microphone_bind_only_local_installation(self):
        recipe = assemble(REPO)
        values = {r['output']:r['value'] for r in recipe['templates']}
        api = values['config/core.json']['services']['platform-api']
        self.assertEqual(api['environment']['PLATFORM_PLUGIN_SOURCE_MODE'], 'offline')
        self.assertEqual(values['public/plugin-import-policy.json']['allowedSources'], ['offline-bundle'])
        self.assertEqual(values['public/plugin-source-catalog.json'], {'schemaVersion':1,'trust':[],'packages':[]})
        self.assertEqual(values['public/plugin-runtime.json']['node']['expectedCertificateFingerprint'],
                         '@@NODE.certificateFingerprint@@')
        realtime = values['config/realtime.json']
        self.assertEqual(realtime['speechTransport']['origin'], '@@OFFICE_ENV.ASR_WORKER_ORIGIN@@')
        self.assertEqual(realtime['placements'][0]['protectedResident']['workerId'], '@@ID.asr@@')
        self.assertIsNone(realtime['placements'][0]['observedLatencyMilliseconds'])


if __name__ == '__main__':
    unittest.main()

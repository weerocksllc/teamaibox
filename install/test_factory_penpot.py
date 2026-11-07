import copy
import json
from pathlib import Path
import re
import subprocess
import unittest

from factory_recipe import assemble, readiness
from factory_penpot import PENPOT_IMAGE_ROLES, configure, selected_features
from factory_application_contract import application_services
from offline_common import InstallError, validate_release
from test_offline_install import release_fixture


ROOT = Path(__file__).resolve().parents[1]


class PenpotFactoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = assemble(ROOT)
        cls.recipe = assemble(ROOT, penpot=True)

    def template(self, name, recipe=None):
        return next(t['value'] for t in (recipe or self.recipe)['templates'] if t['output'] == name)

    def test_feature_is_explicit_and_complete(self):
        self.assertFalse(selected_features([]))
        self.assertTrue(selected_features(['penpot']))
        for bad in [None, 'penpot', ['penpot', 'penpot'], ['unknown'], [{}]]:
            with self.assertRaises(InstallError):
                selected_features(bad)
        base = self.template('config/core.json', self.base)
        full = self.template('config/core.json')
        self.assertEqual(set(full['services']) - set(base['services']), PENPOT_IMAGE_ROLES)
        catalog = self.template('config/application-catalog.json')
        self.assertEqual(len(catalog['applications']), 10)
        self.assertEqual(catalog['requiredApplications'][:-1],
                         self.template('config/application-catalog.json', self.base)['requiredApplications'])
        row = catalog['applications'][-1]
        self.assertEqual(row['manifest']['id'], 'official.penpot')
        services = application_services(row)
        self.assertEqual({s['role'] for s in services}, PENPOT_IMAGE_ROLES)
        self.assertEqual(len({s['digest'] for s in services}), 6)
        self.assertTrue(all(s['readiness'] == 'container-health' for s in services))
        self.assertTrue(PENPOT_IMAGE_ROLES <= {r['role'] for r in readiness(self.recipe)})

    def test_native_stack_private_without_platform_start_dependency(self):
        compose = self.template('config/core.json')
        base = self.template('config/core.json', self.base)
        self.assertEqual(compose['services']['platform-api']['depends_on'], base['services']['platform-api']['depends_on'])
        for role in PENPOT_IMAGE_ROLES:
            s = compose['services'][role]
            self.assertNotIn('ports', s)
            self.assertNotIn('network_mode', s)
            self.assertNotIn('privileged', s)
            self.assertEqual(s['cap_drop'], ['ALL'])
            self.assertIn('no-new-privileges:true', s['security_opt'])
            self.assertNotIn('docker.sock', json.dumps(s))
            self.assertTrue(all(compose['networks'][n]['internal'] for n in s['networks']))
        self.assertNotIn('penpot-mcp', json.dumps(compose['services']['penpot-backend']))
        # Native nginx renders templates shipped under /tmp; mounting tmpfs
        # there hides them and breaks an otherwise successfully built image.
        self.assertEqual(compose['services']['penpot-frontend']['tmpfs'], [])
        self.assertFalse(compose['services']['penpot-frontend'].get('depends_on'))
        self.assertIn('penpot-data',compose['services']['penpot-exporter']['networks'])
        self.assertEqual(compose['services']['penpot-exporter']['environment']['PENPOT_TEAMAIBOX_PROTECTED_EXPORT'], 'true')
        self.assertEqual(compose['services']['platform-api']['environment']['PLATFORM_PENPOT_VERSION'], '2.18.5')

    def test_generated_secrets_and_protected_storage_not_user_configuration(self):
        compose = self.template('config/core.json')
        secrets = [s for s in self.recipe['secrets'] if s['name'].startswith('penpot-')]
        self.assertEqual(len(secrets), 5)
        self.assertEqual(len({s['path'] for s in secrets}), 5)
        self.assertTrue(all(s['bytes'] == 32 and s['format'] == 'base64url' and s['mode'] == '0440' for s in secrets))
        for name, volume in compose['volumes'].items():
            if name.startswith('penpot_'):
                self.assertTrue(volume['driver_opts']['device'].startswith('@@DATA@@/penpot/'))
        controller = self.template('config/agent-controller.json')
        self.assertEqual({k:v for k,v in controller.items() if k != 'penpot'},
                         self.template('config/agent-controller.json', self.base))
        self.assertEqual(controller['penpot']['transportRevision'], 'teamaibox-penpot-transport-2')
        self.assertNotIn('token', json.dumps(controller['penpot']).lower())
        plugin = next(v for v in compose['services']['platform-api']['volumes'] if isinstance(v, dict) and v['source'] == '@@ASSET.penpot-plugin@@')
        self.assertTrue(plugin['read_only'])
        self.assertEqual(compose['services']['penpot-postgres']['environment']['POSTGRES_USER'], 'penpot')
        self.assertEqual(compose['services']['penpot-exporter']['secrets'], ['penpot_session'])
        self.assertIn('PENPOT_SECRET_KEY', ' '.join(compose['services']['penpot-exporter']['entrypoint']))
        for name, service in self.template('config/core.json', self.base)['services'].items():
            if name != 'platform-api':
                self.assertEqual(service, compose['services'][name], name)

    def test_manifest_remains_valid_native_plugin_contract(self):
        script = '''
import {readFileSync} from 'node:fs';
import {validatePluginManifest} from './services/plugin-runtime/src/manifest-validator.mjs';
let value=JSON.parse(readFileSync('deploy/applications/penpot.release-template.json','utf8').replace(/@@IMAGE\\.[^@]+@@/g,'sha256:'+ 'a'.repeat(64)));
// Factory packages authenticate unsigned manifests via the package checksum;
// this synthetic signature only exercises the unchanged manifest shape check.
value.signature={format:'teamaibox.canonical-json/v1',algorithm:'Ed25519',keyId:'synthetic/test',payloadDigest:'sha256' + ':'+'a'.repeat(64),value:Buffer.alloc(64).toString('base64')};
validatePluginManifest(value,{verifyPayloadDigest:false});
'''
        result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_release_requires_every_design_role_asset_and_readiness(self):
        release=release_fixture()
        release['features']=['penpot']
        for role in sorted(PENPOT_IMAGE_ROLES):
            release['images'].append({**release['images'][0], 'role':role})
            release['readiness'].append(dict(role=role,timeoutSeconds=30))
        for role in ('penpot-plugin','penpot-corresponding-source'):
            release['assets'].append({**release['assets'][0], 'role':role,'source':role,'destination':'assets/'+role})
        validate_release(release)
        for kind in ('images','readiness','assets'):
            bad=copy.deepcopy(release)
            bad[kind].pop()
            with self.subTest(kind=kind), self.assertRaises(InstallError):validate_release(bad)
        for features in [[], ['penpot','penpot'], [{}]]:
            bad=copy.deepcopy(release);bad['features']=features
            with self.assertRaises(InstallError):validate_release(bad)
        bad=copy.deepcopy(release);bad['images'].append({**bad['images'][-1],'role':'penpot-unknown'})
        with self.assertRaises(InstallError):validate_release(bad)


if __name__ == '__main__':
    unittest.main()

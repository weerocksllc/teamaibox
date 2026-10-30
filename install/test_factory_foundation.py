import json
from pathlib import Path
import re
import unittest
import uuid

from factory_bootstrap import expand, variables
from factory_foundation import foundation
from test_offline_install import release_fixture


class FoundationTests(unittest.TestCase):
    def setUp(self):
        self.recipe = foundation(Path(__file__).resolve().parents[1])

    def test_sources_never_read_a_live_configuration(self):
        raw = json.dumps(self.recipe)
        self.assertNotRegex(raw, r'192\.168\.10\.(10|19|20|23)\b')
        self.assertNotIn('spark23', raw)
        self.assertNotIn('BACKUP_', raw)
        self.assertNotIn('ca.key', raw)
        self.assertEqual({v['output'] for v in self.recipe['templates'] if v['runtimeMutable']},
                         {'public/ai-startup.json', 'public/phone-media-state.json', 'public/appliance-addresses.json'})

    def test_references_and_identity_are_connected_to_runtime_mounts(self):
        outputs = {v['output']: v for v in self.recipe['templates']}
        self.assertTrue(set(self.recipe['references'].values()) <= set(outputs))
        self.assertEqual(outputs['data/node/identity/node.json']['value'], '@@NODE.identity@@')
        self.assertEqual(outputs['config/guest-storage.json']['value'], '@@GUEST.storage@@')
        self.assertEqual(outputs['config/guests/phones.json']['value'], '@@GUEST.phones@@')
        compose = outputs[self.recipe['composeFile']]['value']
        self.assertEqual(compose['volumes']['node_agent_identity']['driver_opts']['device'], '@@DATA@@/node/identity')
        self.assertEqual(compose['services']['platform-api']['environment']['PLATFORM_API_SETUP_TOKEN_FILE'],
                         '/run/secrets/owner_setup_token')
        self.assertEqual(outputs['config/frontdoor.json']['value']['retired'], [])

    def test_phone_address_state_is_shared_by_network_maintainer_and_agent(self):
        output = {v['output']: v['value'] for v in self.recipe['templates']}
        network = output['config/network-identity.json']
        self.assertEqual(network['phoneMedia']['stateFile'], '@@ROOT@@/public/phone-media-state.json')
        self.assertEqual(network['phoneMedia']['controlNetworkId'], '@@NETWORK_ID.phone-control@@')
        state = output['public/phone-media-state.json']
        self.assertEqual(state['status'], 'preparing')
        self.assertEqual(state['runs'], {})

    def test_drawing_ui_intents_are_bound_to_the_authenticated_local_worker(self):
        output = {v['output']: v['value'] for v in self.recipe['templates']}
        compose = output['config/core.json']
        api = compose['services']['platform-api']['environment']
        self.assertEqual(set(api.get('DRAWING_MODEL_ALIASES', '').split(',')),
                         {'local/drawing-default', 'drawing.automatic', 'drawing.fast'})
        self.assertEqual(api['DRAWING_MODEL_ALIAS'], '@@OFFICE_ENV.DRAWING_MODEL_ALIAS@@')
        self.assertEqual(api['DRAWING_WORKER_TOKEN_FILE'], '/run/secrets/factory_drawing_provider')
        self.assertIn('factory_drawing_provider', compose['services']['platform-api']['secrets'])

    def test_publication_does_not_bundle_keys_or_create_a_user(self):
        public = [v for v in self.recipe['tlsCopies'] if v['path'].startswith('public/')]
        self.assertTrue(all(v['source'].endswith('.crt') for v in public))
        self.assertFalse(any(v['source'] == 'ca.key' for v in self.recipe['tlsCopies']))
        self.assertFalse(any('password' in v['output'] or 'account' in v['output'] for v in self.recipe['templates']))
        self.assertEqual({v['value']['clientUid'] for v in self.recipe['templates']
                          if v['output'] == 'config/guest-camera.json'}, {10001})


if __name__ == '__main__':
    unittest.main()

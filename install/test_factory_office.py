import copy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

from factory_office import bind, definitions, PROFILES, bind_retained_identity

REPO = Path(__file__).resolve().parents[1]


class OfficeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix='factory-spec-')
        cls.binary = Path(cls.temporary.name) / 'factory-worker-spec'
        subprocess.run(['go', 'build', '-o', str(cls.binary), './cmd/factory-worker-spec'],
                       cwd=REPO / 'services/node-agent', check=True, capture_output=True)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def bindings(self, identity=None):
        return bind(definitions(REPO), identity or str(uuid.uuid4()),
                    {role + '-worker': 'sha256:' + 'a' * 64 for role in PROFILES},
                    {role + '-model': '/srv/test/data/assets/' + role for role in PROFILES}
                    | {'drawing-runtime': '/srv/test/data/assets/drawing-runtime'})

    def normalize(self, binding, role):
        p = binding['profiles'][role]
        return subprocess.run([str(self.binary)], input=json.dumps(dict(targetKey=p['targetKey'],
            stageOrder=p['stageOrder'], payload=binding['workers'][role],
            installationId='00000000-0000-4000-8000-000000000001',
            nodeId='00000000-0000-4000-8000-000000000002')), text=True, capture_output=True)

    def test_every_fresh_worker_is_accepted_by_actual_agent_policy(self):
        value = self.bindings()
        for role in PROFILES:
            with self.subTest(role=role):
                result = self.normalize(value, role)
                self.assertEqual(result.returncode, 0, result.stderr)
                output = json.loads(result.stdout)
                bind_retained_identity(output, {'nodeId': '00000000-0000-4000-8000-000000000002',
                    'installationId': '00000000-0000-4000-8000-000000000001'})
                self.assertEqual(output['target']['requiredLabels']['com.teamaibox.node-generation'], '1')
                self.assertEqual(output['target']['requiredLabels']['com.teamaibox.node-id'],
                    '00000000-0000-4000-8000-000000000002')
                self.assertRegex(output['target']['requiredStartSpecDigest'], '^sha256:[a-f0-9]{64}$')
                self.assertEqual(output['payload']['workerId'], value['profiles'][role]['workerId'])
                request = output['createRequest']
                self.assertEqual(request['HostConfig']['RestartPolicy']['Name'], 'no')
                self.assertEqual(request['HostConfig']['MemorySwap'], request['HostConfig']['Memory'])
                self.assertEqual(request['Labels']['com.teamaibox.start-spec-digest'],
                                 output['target']['requiredStartSpecDigest'].split(':')[1])

    def test_independent_installations_do_not_share_worker_profiles_or_volumes(self):
        first, second = self.bindings(), self.bindings()
        self.assertFalse(set(first['volumes']) & set(second['volumes']))
        for role in PROFILES:
            self.assertNotEqual(first['profiles'][role]['workerId'], second['profiles'][role]['workerId'])
            self.assertNotEqual(first['profiles'][role]['modelProfileId'], second['profiles'][role]['modelProfileId'])
        self.assertEqual(self.bindings('00000000-0000-4000-8000-000000000001'),
                         self.bindings('00000000-0000-4000-8000-000000000001'))

    def test_offline_loading_and_persistent_empty_caches(self):
        result = self.bindings()
        for role, payload in result['workers'].items():
            self.assertEqual(payload['environment']['HF_HUB_OFFLINE'], '1')
            self.assertEqual(payload['environment']['TRANSFORMERS_OFFLINE'], '1')
            if role != 'asr':
                self.assertTrue(any(not m['readOnly'] for m in payload['mounts']))
            for mount in payload['mounts']:
                self.assertTrue(mount['source'].startswith('teamaibox-factory-'))
        self.assertEqual(sum(p['declaredResidentBytes'] for p in result['profiles'].values()), 64 * 1024**3)
        self.assertNotIn('192.168.10.', json.dumps(result))
        self.assertNotIn('/home/', json.dumps(result))
        self.assertEqual(result['workers']['ocr']['environment']['PYTHONPATH'], '/app')
        self.assertEqual(result['workers']['ocr']['environment']['MODEL_LOCAL_FILES_ONLY'], 'true')
        self.assertEqual(next(d['mode'] for d in result['directories']
                              if d['path']=='office/cache/drawing/0'), '0700')

    def test_auth_is_new_local_material_not_a_packaged_token(self):
        result = self.bindings()
        volumes = result['volumes']
        drawing = result['workers']['drawing']
        auth = next(m for m in drawing['mounts'] if m['target'] == '/run/secrets/auth')
        self.assertEqual(volumes[auth['source']]['source'], '@@DATA@@/office/auth/drawing')
        self.assertEqual(drawing['environment']['TEAMAIBOX_DRAWING_MODEL_REPOSITORY'], 'black-forest-labs/FLUX.2-klein-4B')
        self.assertFalse(any('TOKEN' in k and not k.endswith('_FILE') for k in drawing['environment']))

    def test_agent_rejects_unsafe_mount_and_unknown_payload_fields(self):
        value = self.bindings()
        value['workers']['assistant']['mounts'][0].update(type='bind', source='/etc', readOnly=False)
        self.assertNotEqual(self.normalize(value, 'assistant').returncode, 0)
        value = self.bindings()
        value['workers']['assistant']['ignorePolicy'] = True
        self.assertNotEqual(self.normalize(value, 'assistant').returncode, 0)


if __name__ == '__main__':
    unittest.main()

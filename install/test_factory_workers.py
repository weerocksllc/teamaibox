from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from factory_workers import create_stopped
from offline_common import InstallError, read_json


class Engine:
    def __init__(self):
        self.containers = {}
        self.calls = []
        self.lost_response = False

    def __call__(self, method, path, request=None):
        self.calls.append((method, path))
        if path.startswith('/images/'):
            return 200, dict(Id='sha256:' + 'a' * 64, Architecture='arm64', Os='linux')
        if method == 'GET':
            name = path.split('/')[2]
            return (200, deepcopy(self.containers[name])) if name in self.containers else (404, None)
        if method == 'POST' and path.startswith('/containers/create?name='):
            name = path.split('=', 1)[1]
            self.containers[name] = dict(Id=hashlib.sha256(name.encode()).hexdigest(), Name='/' + name,
                Image=request['Image'], Config={k: deepcopy(v) for k, v in request.items() if k != 'HostConfig'},
                HostConfig=deepcopy(request['HostConfig']), Mounts=[], State=dict(Running=False))
            if self.lost_response:
                self.lost_response = False
                raise OSError('simulated response loss after create')
            return 201, {'Id': self.containers[name]['Id']}
        raise AssertionError('unexpected side effect: ' + method + ' ' + path)


class WorkerCreationTests(unittest.TestCase):
    def fixture(self):
        installation = '00000000-0000-4000-8000-000000000001'
        profiles = {role: dict(workerId=f'00000000-0000-4000-8000-{i:012d}')
                    for i, role in enumerate(('assistant', 'translation', 'embedding', 'asr', 'ocr', 'drawing'), 2)}
        requests = {role: dict(Image='sha256:' + 'a' * 64,
            Labels={'com.teamaibox.installation-id': installation, 'com.teamaibox.worker-id': p['workerId']},
            Env=['HF_HUB_OFFLINE=1'], HostConfig=dict(RestartPolicy={'Name': 'no'}, AutoRemove=False, Memory=1234))
            for role, p in profiles.items()}
        return dict(profiles=profiles, createRequests=requests), installation

    def test_creates_only_new_stopped_containers_and_check_has_no_writes(self):
        value, identity = self.fixture()
        engine = Engine()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = create_stopped(root, value, identity, engine=engine)
            self.assertEqual(len(first['containers']), 6)
            self.assertEqual(sum(method == 'POST' for method, _ in engine.calls), 6)
            self.assertTrue(all(not c['State']['Running'] for c in engine.containers.values()))
            saved = (root / 'office-container-creation.json').read_bytes()
            engine.calls.clear()
            with patch('factory_workers.write_json', side_effect=AssertionError('check wrote state')):
                self.assertEqual(create_stopped(root, value, identity, check=True, engine=engine), first)
            self.assertEqual((root / 'office-container-creation.json').read_bytes(), saved)
            self.assertTrue(all(method == 'GET' for method, _ in engine.calls))

    def test_lost_create_response_reconciles_without_duplicate_or_restart(self):
        value, identity = self.fixture()
        engine = Engine()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            engine.lost_response = True
            with self.assertRaises(OSError):
                create_stopped(root, value, identity, engine=engine)
            self.assertEqual(len(engine.containers), 1)
            create_stopped(root, value, identity, engine=engine)
            self.assertEqual(len(engine.containers), 6)
            self.assertEqual(sum(method == 'POST' for method, _ in engine.calls), 6)

    def test_foreign_name_is_preserved_and_whole_set_prechecked(self):
        value, identity = self.fixture()
        engine = Engine()
        name = 'teamaibox-worker-' + value['profiles']['drawing']['workerId']
        engine.containers[name] = {'Name': '/' + name}
        before = deepcopy(engine.containers)
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(InstallError):
            create_stopped(Path(directory), value, identity, engine=engine)
        self.assertEqual(engine.containers, before)
        self.assertTrue(all(method == 'GET' for method, _ in engine.calls))

    def test_recorded_container_removal_and_configuration_drift_are_not_repaired(self):
        value, identity = self.fixture()
        for change in ('removed', 'configuration'):
            with self.subTest(change=change), tempfile.TemporaryDirectory() as directory:
                root, engine = Path(directory), Engine()
                create_stopped(root, value, identity, engine=engine)
                name = next(iter(engine.containers))
                if change == 'removed':
                    del engine.containers[name]
                else:
                    engine.containers[name]['Config']['Env'] = ['HF_HUB_OFFLINE=0']
                engine.calls.clear()
                with self.assertRaises((InstallError, RuntimeError)):
                    create_stopped(root, value, identity, engine=engine)
                self.assertTrue(all(method == 'GET' for method, _ in engine.calls))

    def test_check_missing_journal_never_adopts_a_container(self):
        value, identity = self.fixture()
        engine = Engine()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(InstallError):
                create_stopped(root, value, identity, check=True, engine=engine)
            self.assertEqual(list(root.iterdir()), [])


if __name__ == '__main__':
    unittest.main()

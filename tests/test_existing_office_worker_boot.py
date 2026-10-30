import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('workerboot', ROOT/'tools/restore_existing_office_workers.py')
boot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(boot)


class WorkerBootTests(unittest.TestCase):
    def test_identity_drift_fails_closed(self):
        c = {'Id': 'a'*64, 'Image': 'sha256:'+'b'*64, 'Name': '/teamaibox-worker-test',
             'Config': {'Env': ['SECRET=never-emitted']},
             'HostConfig': {'RestartPolicy': {'Name':'no'}, 'AutoRemove':False}, 'Mounts': []}
        e = {'id': c['Id'], 'image': c['Image'], 'name': c['Name'][1:],
             'configurationSha256': boot.configuration_digest(c)}
        boot.validate_identity(c,e)
        for field, val in [('Id','other'), ('Image','other'), ('Name','/other'), ('Config',{})]:
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                boot.validate_identity({**c, field:val}, e)

    def test_no_broad_lifecycle_or_model_changes(self):
        text = (ROOT/'tools/restore_existing_office_workers.py').read_text()
        self.assertIn("['docker', 'start', c['id']]", text)
        for verb in ['run','rm','stop','pull','update','create']:
            self.assertNotIn("['docker', '"+verb+"'", text)
        self.assertIn('16 * 1024**3', text)

    def test_mount_array_order_is_not_configuration_drift(self):
        c={'Config':{},'HostConfig':{},'Mounts':[{'Destination':'/a'},{'Destination':'/b'}]}
        d={**c,'Mounts':list(reversed(c['Mounts']))}
        self.assertEqual(boot.configuration_digest(c),boot.configuration_digest(d))

    def test_docker_restart_empty_dns_normalization(self):
        c={'Config':{},'HostConfig':{'Dns':None,'DnsOptions':None,'DnsSearch':None},'Mounts':[]}
        d={**c,'HostConfig':{'Dns':[],'DnsOptions':[],'DnsSearch':[]}}
        self.assertEqual(boot.configuration_digest(c),boot.configuration_digest(d))
        self.assertEqual(d['HostConfig']['Dns'], [])
        for key in ('Dns','DnsOptions','DnsSearch'):
            altered={**d,'HostConfig':{**d['HostConfig'],key:['unexpected']}}
            self.assertNotEqual(boot.configuration_digest(c),boot.configuration_digest(altered))


if __name__ == '__main__':
    unittest.main()

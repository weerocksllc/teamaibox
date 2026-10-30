from copy import deepcopy
import unittest
from restore_existing_office_workers import configuration_digest, validate_identity


class ConfigurationDigestTests(unittest.TestCase):
    def test_docker_cgroup_v2_start_normalizes_false_to_null(self):
        before = dict(Id='a'*64, Image='sha256:'+'b'*64, Name='/test', Config={}, Mounts=[],
                      HostConfig=dict(OomKillDisable=False, RestartPolicy=dict(Name='no'), AutoRemove=False))
        after = deepcopy(before)
        after['HostConfig']['OomKillDisable'] = None
        self.assertEqual(configuration_digest(before), configuration_digest(after))
        entry = dict(id=before['Id'], image=before['Image'], name='test',
                     configurationSha256=configuration_digest(before))
        validate_identity(after, entry)
        # Existing manifests captured while running remain valid after restart.
        entry['configurationSha256'] = configuration_digest(after, legacy_oom=True)
        validate_identity(before, entry)
        before['HostConfig']['OomKillDisable'] = True
        with self.assertRaisesRegex(RuntimeError, 'configuration_drift'):
            validate_identity(before, entry)


if __name__ == '__main__':
    unittest.main()

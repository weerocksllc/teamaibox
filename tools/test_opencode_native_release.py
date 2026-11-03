import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from tools import validate_opencode_native_release as release
from tools.opencode_release_contract import canonical, digest_bytes, _create_source_archive

class NativeReleaseGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        names = ['architecture/opencode/upstream-lock.v1.json', 'architecture/opencode/compatibility-gate.v2.json',
                 'services/agent-bridge/opencode-native-contract.json', 'services/agent-bridge/src/opencode-adapter-v1-19.mjs',
                 'deploy/agent/sandbox-policy.v1.json', 'deploy/agent/OpenCode.Dockerfile',
                 'deploy/agent/AgentSandbox.Dockerfile', 'deploy/agent/native-extensions/package.json']
        for name in names:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(release.ROOT / name, target)
        self.gate = self.root / names[1]
        value = json.loads(self.gate.read_text())
        value['sourceRoots'] = ['fixture.txt']
        self.gate.write_text(json.dumps(value))
        (self.root / 'fixture.txt').write_text('synthetic release source')

    def proof(self):
        current = release.validate(self.root)
        gate = json.loads(self.gate.read_text())
        value = {'schemaVersion': 2, 'kind': 'teamaibox.native-upgrade-acceptance',
                 'version': current['version'], 'artifact': current['artifact'], 'source': current['source'],
                 'architecture': 'linux/arm64/v8', 'nativeApiSha256': json.loads((self.root / 'services/agent-bridge/opencode-native-contract.json').read_text())['api']['sha256'],
                 'checks': dict.fromkeys(gate['requiredReleaseChecks'], True),
                 'images': dict.fromkeys(gate['requiredImageRoles'], 'sha256:' + 'a' * 64),
                 'sensitiveContentRetained': False}
        return value

    def save_proof(self, value):
        value = copy.deepcopy(value)
        value['evidenceDigest'] = digest_bytes(canonical(value))
        path = self.root / 'synthetic-unit-proof.json'
        path.write_text(json.dumps(value))
        return path

    def test_source_consistency_does_not_claim_runtime_acceptance(self):
        self.assertFalse(release.validate(self.root)['releaseAccepted'])

    def test_version_and_artifact_mismatches_are_rejected(self):
        contract = self.root / 'services/agent-bridge/opencode-native-contract.json'
        value = json.loads(contract.read_text())
        value['version'] = '1.18.16'
        contract.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'version'):
            release.validate(self.root)
        value['version'] = '1.19.5'
        value['artifact']['sha256'] = '0' * 64
        contract.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'artifact'):
            release.validate(self.root)

    def test_current_source_binding_and_failed_checks_are_enforced(self):
        value = self.proof()
        self.assertTrue(release.validate(self.root, self.save_proof(value))['releaseAccepted'])
        value['checks']['native-version'] = False
        with self.assertRaisesRegex(ValueError, 'checks'):
            release.validate(self.root, self.save_proof(value))
        value['checks']['native-version'] = True
        path = self.save_proof(value)
        (self.root / 'fixture.txt').write_text('changed synthetic source')
        with self.assertRaisesRegex(ValueError, 'exact source'):
            release.validate(self.root, path)

    def test_historical_receipt_is_not_new_release_proof(self):
        value = json.loads((release.ROOT / 'architecture/opencode/compatibility-evidence.v1.json').read_text())
        with self.assertRaisesRegex(ValueError, 'current native'):
            release.validate(self.root, self.save_proof(value))

    def test_public_entry_point_requires_explicit_release_observations(self):
        result = subprocess.run([sys.executable, 'tools/validate_opencode_compatibility_gate.py', '--require-release'], cwd=release.ROOT, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'requires --evidence', result.stderr)

    def test_public_archive_is_reproducible_and_scoped(self):
        a, count = _create_source_archive(['fixture.txt'], self.root / 'a.tgz', self.root)
        b, other_count = _create_source_archive(['fixture.txt'], self.root / 'b.tgz', self.root)
        self.assertEqual((a, count), (b, other_count))
        with self.assertRaises(ValueError):
            _create_source_archive(['../outside'], self.root / 'bad.tgz', self.root)

if __name__ == '__main__':
    unittest.main()

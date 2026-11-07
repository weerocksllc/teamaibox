import copy
import json
from pathlib import Path
import tempfile
import unittest

from build_penpot_agent import ROOT, validate_artifact
from build_public_services import validate_penpot_input
from offline_common import InstallError
from source_download import file_hash


class PenpotAgentArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='penpot-artifact-check-')
        self.root = Path(self.temporary.name)
        (self.root / 'opencode').write_bytes(b'synthetic-test-artifact-not-an-executable')
        (self.root / 'LICENSE.opencode').write_text('Synthetic license fixture')
        self.digest = file_hash(self.root / 'opencode')
        lock = json.loads((ROOT / 'deploy/opencode-penpot-transport.lock.json').read_text())
        self.manifest = dict(upstreamCommit=lock['commit'], upstreamTree=lock['tree'],
            upstreamVersion=lock['upstreamVersion'], version=lock['candidateVersion'],
            patchRevision=lock['patchRevision'], modifiedByPlatform=True,
            lockSha256=file_hash(ROOT / 'deploy/opencode-penpot-transport.lock.json'),
            patcherSha256=file_hash(ROOT / 'install/apply_opencode_transport_patch.py'),
            modified={name:'a' * 64 for name in ['packages/opencode/src/session/tools.ts',
                'packages/opencode/src/mcp/catalog.ts', 'packages/opencode/src/mcp/index.ts', 'packages/plugin/src/index.ts']})
        self.save()

    def save(self):
        (self.root / 'teamaibox-transport-patch.json').write_text(json.dumps(self.manifest))

    def tearDown(self):
        self.temporary.cleanup()

    def test_matching_artifact_metadata(self):
        self.assertEqual(validate_artifact(self.root, self.digest), self.manifest)

    def test_changed_bytes_rejected(self):
        (self.root / 'opencode').write_bytes(b'different synthetic artifact')
        with self.assertRaisesRegex(InstallError, 'checksum'):
            validate_artifact(self.root, self.digest)

    def test_source_and_patch_drift_rejected(self):
        original = copy.deepcopy(self.manifest)
        for key in ['upstreamTree', 'lockSha256', 'patcherSha256', 'patchRevision', 'modifiedByPlatform']:
            with self.subTest(key=key):
                self.manifest = {**original, key: False if key == 'modifiedByPlatform' else 'changed'}
                self.save()
                with self.assertRaisesRegex(InstallError, 'identity mismatch'):
                    validate_artifact(self.root, self.digest)

    def test_symlink_artifact_rejected(self):
        path = self.root / 'LICENSE.opencode'
        path.rename(self.root / 'original-license')
        path.symlink_to(self.root / 'original-license')
        with self.assertRaisesRegex(InstallError, 'regular files'):
            validate_artifact(self.root, self.digest)

    def test_public_build_requires_complete_native_input_and_role(self):
        validate_penpot_input(ROOT, ['web'], None, None)
        validate_penpot_input(ROOT, ['agent-sandbox'], self.root, self.digest)
        for roles, artifact, checksum in [(['agent-sandbox'], self.root, None),
                (['agent-sandbox'], None, self.digest), (['web'], self.root, self.digest)]:
            with self.subTest(roles=roles, artifact=bool(artifact), checksum=bool(checksum)):
                with self.assertRaises(InstallError):
                    validate_penpot_input(ROOT, roles, artifact, checksum)


if __name__ == '__main__':
    unittest.main()

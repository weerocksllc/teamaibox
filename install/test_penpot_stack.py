"""Candidate preparation/cache checks. No containers, network or user data."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import build_penpot_stack as stack
from offline_common import InstallError, write_json


class PenpotStackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.source = self.root / 'source'
        for name in ('backend', 'common', 'frontend', 'plugins', 'mcp', 'render-wasm',
                     'exporter', 'docker/images/files'):
            (self.source / name).mkdir(parents=True)
            (self.source / name / 'fixture.txt').write_text(name)
        for name in ('LICENSE', 'CHANGES.md'):
            (self.source / name).write_text(name)
        self.output = self.root / 'candidate'
        self.output.mkdir()
        self.state = {'schema': 'penpot-candidate-build-v1', 'sources': {}, 'images': {}}

    def test_mcp_change_invalidates_editor_and_mcp_not_backend_or_exporter(self):
        before = {role: stack.role_input(self.source, role)[1] for role in stack.ROLES}
        (self.source / 'mcp/fixture.txt').write_text('protected plugin change')
        after = {role: stack.role_input(self.source, role)[1] for role in stack.ROLES}
        self.assertNotEqual(before['penpot-mcp'], after['penpot-mcp'])
        self.assertNotEqual(before['penpot-frontend'], after['penpot-frontend'])
        self.assertEqual(before['penpot-backend'], after['penpot-backend'])
        self.assertEqual(before['penpot-exporter'], after['penpot-exporter'])

    def test_content_and_executable_bits_affect_source_identity(self):
        path = self.source / 'mcp/fixture.txt'
        first = stack.tree_digest(self.source)
        path.chmod(0o755)
        self.assertNotEqual(stack.tree_digest(self.source), first)
        (self.source / 'escape').symlink_to(self.root)
        with self.assertRaises(InstallError):
            stack.tree_digest(self.source)

    def test_failed_role_resume_keeps_successful_image_and_old_logs(self):
        calls, existing = [], {}
        fail = True

        def run(command, **kwargs):
            nonlocal fail
            tag = command[command.index('--tag') + 1]
            calls.append(command)
            if 'penpot-exporter-' in tag and fail:
                fail = False
                kwargs['stdout'].write(b'synthetic interrupted build\n')
                return subprocess.CompletedProcess(command, 1)
            existing[tag] = 'sha256:' + str(len(calls)).zfill(64)
            return subprocess.CompletedProcess(command, 0)

        def inspect(ref, _key):
            return existing.get(ref, ref if ref in existing.values() else None)

        roles = ['penpot-backend', 'penpot-exporter']
        with patch.object(stack.subprocess, 'run', side_effect=run), patch.object(stack, 'inspect_image', side_effect=inspect):
            with self.assertRaises(InstallError):
                stack.build_roles(self.source, 'source-key', self.output, self.state, roles)
            first = json.loads((self.output / 'images.json').read_text())
            self.assertEqual(first['status'], 'failed')
            self.assertIn('penpot-backend', first['images'])
            saved = json.loads((self.output / 'state.json').read_text())
            result = stack.build_roles(self.source, 'source-key', self.output, saved, roles)
            self.assertEqual(result['reused'], ['penpot-backend'])
            self.assertEqual(len(calls), 3)
            self.assertEqual(len(list((self.output / 'attempts').glob('*/build.log'))), 3)
            self.assertFalse(result['deployed'])
            self.assertFalse(result['releaseAccepted'])
            self.assertEqual(first['images']['penpot-backend'], result['images']['penpot-backend'])

    def test_wrong_architecture_or_wrong_input_label_rejected(self):
        image = {'Architecture': 'arm64', 'Os': 'linux', 'Id': 'sha256:fixture',
                 'Config': {'Labels': {'com.teamaibox.penpot.input': 'expected'}}}
        for field, value in [('Architecture', 'amd64'), ('Config', {'Labels': {}})]:
            result = subprocess.CompletedProcess([], 0, json.dumps([{**image, field: value}]))
            with patch.object(stack.subprocess, 'run', return_value=result), self.assertRaises(InstallError):
                stack.inspect_image('fixture', 'expected')

    def test_existing_unrelated_output_and_symlink_state_preserved(self):
        with self.assertRaises(InstallError):
            stack.build(self.root / 'cache', self.output, ['penpot-mcp'])
        (self.root / 'other.json').write_text('{}')
        (self.output / 'state.json').symlink_to(self.root / 'other.json')
        with self.assertRaises(InstallError):
            stack.build(self.root / 'cache', self.output, ['penpot-mcp'])
        self.assertEqual((self.root / 'other.json').read_text(), '{}')

    def test_changed_prepared_source_is_rejected_without_rewriting_evidence(self):
        inputs = {'source': {'commit': 'fixture'}, 'patches': {name: 'fixture' for name in stack.PATCH_INPUTS}}
        key = stack.fingerprint(inputs)
        prepared = self.output / 'sources' / key
        prepared.mkdir(parents=True)
        (prepared / 'original.txt').write_text('original')
        self.state['sources'][key] = {'treeSha256': stack.tree_digest(prepared)}
        (prepared / 'original.txt').write_text('modified outside builder')
        original_hash = stack.file_hash
        with patch.object(stack, 'read_json', return_value=inputs['source']), \
             patch.object(stack, 'file_hash', side_effect=lambda path: 'fixture'
                          if Path(path).is_relative_to(stack.ROOT) else original_hash(path)), self.assertRaises(InstallError):
            stack.prepare_candidate(self.root / 'cache', self.output, self.state)
        self.assertEqual((prepared / 'original.txt').read_text(), 'modified outside builder')

    def test_concurrent_build_does_not_start_another_preparation(self):
        import fcntl
        write_json(self.output / 'state.json', self.state)
        with (self.output / '.build.lock').open('w') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(stack, 'prepare_candidate') as prepare, self.assertRaises(RuntimeError):
                stack.build(self.root / 'cache', self.output, ['penpot-mcp'])
            prepare.assert_not_called()


if __name__ == '__main__':
    unittest.main()

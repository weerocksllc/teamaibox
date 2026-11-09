"""Source-level regression checks for the pinned native save-status overlay."""
import hashlib
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import build_penpot_stack as stack
from offline_common import InstallError, read_json
from package_penpot_sources import BUILD_FILES
import penpot_save_status_patch as save_status


class PenpotSaveStatusPatchTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.path = self.root / save_status.INPUT
        self.path.parent.mkdir(parents=True)

    def test_checks_live_buffer_after_debounce_and_preserves_other_streams(self):
        prefix = b'(rx/filter (fn [_] @buffered?))\n(rx/map (fn [_] ::force-persist))\n'
        suffix = b'\n(rx/tap (fn [_] (vreset! buffered? false)))\n'
        source = prefix + save_status.PENDING_STREAM + suffix
        self.path.write_bytes(source)
        with patch.object(save_status, 'SHA256', hashlib.sha256(source).hexdigest()):
            save_status.patch(self.root)
            with self.assertRaisesRegex(InstallError, 'source mismatch'):
                save_status.patch(self.root)
        patched = self.path.read_bytes()
        self.assertTrue(patched.startswith(prefix) and patched.endswith(suffix))
        pending = patched[len(prefix):-len(suffix)]
        self.assertLess(pending.index(b'(rx/debounce 200)'), pending.index(b'(rx/filter (fn [_] @buffered?))'))
        self.assertLess(pending.index(b'(rx/filter (fn [_] @buffered?))'), pending.index(b'(update-status :pending)'))
        self.assertNotIn(b':saved', pending)

    def test_rejects_wrong_digest_and_missing_or_ambiguous_context_without_writing(self):
        for source in (b'changed upstream source', save_status.PENDING_STREAM * 2):
            self.path.write_bytes(source)
            with self.assertRaisesRegex(InstallError, 'source mismatch'):
                save_status.patch(self.root)
            with patch.object(save_status, 'SHA256', hashlib.sha256(source).hexdigest()), \
                    self.assertRaisesRegex(InstallError, 'context mismatch'):
                save_status.patch(self.root)
            self.assertEqual(self.path.read_bytes(), source)

    def test_patch_is_a_build_input_and_corresponding_source(self):
        self.assertIn('penpot_save_status_patch.py', stack.PATCH_INPUTS)
        self.assertIn('install/penpot_save_status_patch.py', BUILD_FILES)
        self.assertIs(stack.patch_save_status, save_status.patch)

    def test_candidate_preparation_applies_and_records_the_overlay(self):
        source = save_status.PENDING_STREAM
        self.path.write_bytes(source)
        out = self.root / 'candidate'
        out.mkdir()
        state = {'sources': {}}

        def native_source(_root, _cache, target, _archive):
            path = target / save_status.INPUT
            path.parent.mkdir(parents=True)
            path.write_bytes(source)
            (target / 'LICENSE').write_text('synthetic license fixture')
            (target / 'mcp').mkdir()
            return target

        with patch.object(save_status, 'SHA256', hashlib.sha256(source).hexdigest()), \
                patch.object(stack, 'prepare', side_effect=native_source), \
                patch.object(stack, 'patch_identity', side_effect=lambda tree, _target: tree), \
                patch.object(stack, 'patch_mcp', side_effect=lambda tree, _target: tree), \
                patch.object(stack, 'patch_download'):
            candidate, key = stack.prepare_candidate(self.root / 'cache', out, state)
            self.assertEqual(stack.prepare_candidate(self.root / 'cache', out, state), (candidate, key))
        self.assertIn(b'(rx/filter (fn [_] @buffered?))', (candidate / save_status.INPUT).read_bytes())
        self.assertEqual((self.root / save_status.INPUT).read_bytes(), source)
        self.assertIn('penpot_save_status_patch.py',
                      read_json(candidate / 'teamaibox-integration-inputs.json')['patches'])

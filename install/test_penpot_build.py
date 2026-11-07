"""Isolated contract checks; no Docker, network or existing data is used."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
from apply_penpot_patches import patch_schema_migration_runner
from build_penpot_mcp import build
from offline_common import InstallError


class BuildPilotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / 'repo'
        (self.repo / 'deploy').mkdir(parents=True)
        (self.repo / 'install/images').mkdir(parents=True)
        (self.repo / 'deploy/penpot-source.lock.json').write_text('{"commit":"fixture"}')
        (self.repo / 'install/images/penpot-mcp-source.Dockerfile').write_text('FROM fixture')
        self.output = self.root / 'build'

    def run_build(self, result=0, architecture='arm64'):
        with patch('build_penpot_mcp.prepare', return_value=self.output / 'source'), \
             patch('build_penpot_mcp.subprocess.run', return_value=subprocess.CompletedProcess([], result)) as command, \
             patch('build_penpot_mcp.subprocess.check_output', return_value=json.dumps([
                 {'Architecture': architecture, 'Os': 'linux', 'Id': 'sha256:fixture'}]).encode()):
            value = build(self.repo, self.root / 'cache', self.output)
        return value, command.call_args.args[0]

    def test_success_records_candidate_not_deployment(self):
        report, command = self.run_build()
        self.assertFalse(report['deployed'])
        self.assertEqual(report['status'], 'pilot-built-not-release-accepted')
        self.assertIn('--platform=linux/arm64', command)
        self.assertEqual(command[-1], str(self.output / 'source/mcp'))
        self.assertEqual(json.loads((self.output / 'images.json').read_text()), report)

    def test_failure_preserves_evidence_without_success_report(self):
        with self.assertRaises(InstallError):
            self.run_build(result=1)
        self.assertTrue((self.output / 'inputs.json').exists())
        self.assertTrue((self.output / 'build.log').exists())
        self.assertFalse((self.output / 'images.json').exists())

    def test_wrong_architecture_never_reports_success(self):
        with self.assertRaises(InstallError):
            self.run_build(architecture='amd64')
        self.assertFalse((self.output / 'images.json').exists())

    def test_existing_output_and_checkout_output_are_rejected(self):
        self.output.mkdir()
        with self.assertRaises(InstallError):
            self.run_build()
        self.output = self.repo / 'build-output'
        with self.assertRaises(InstallError):
            self.run_build()
        self.assertFalse(self.output.exists())


class SchemaMigrationOverlayTests(unittest.TestCase):
    SOURCE = ('[next.jdbc :as jdbc]))\n'
              '      (run! #(impl-migrate-single conn mname %) steps))))')

    def test_schema_fence_runs_before_native_migration(self):
        patched = patch_schema_migration_runner(self.SOURCE)
        self.assertIn('[next.jdbc.result-set :as rs]', patched)
        self.assertLess(patched.index('pg_advisory_xact_lock'), patched.index('select step from migrations'))
        self.assertLess(patched.index(':penpot-incompatible-schema'), patched.index('(run! #(impl-migrate-single'))

    def test_missing_or_ambiguous_native_source_refuses_patch(self):
        for content in (self.SOURCE.replace('impl-migrate-single', 'changed'), self.SOURCE * 2):
            with self.subTest(content=content), self.assertRaises(InstallError):
                patch_schema_migration_runner(content)


if __name__ == '__main__':
    unittest.main()

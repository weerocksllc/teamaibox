"""Exercise the coordinator with disposable state, without a Docker daemon."""
from contextlib import ExitStack
from copy import deepcopy
import fcntl
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import installer
from offline_common import InstallError, read_json, write_json
from test_offline_install import release_fixture


class PreflightTests(unittest.TestCase):
    def facts(self):
        return dict(platform='linux', architecture='aarch64', uid=0, os='ubuntu:24.04',
                    docker=dict(OSType='linux', Architecture='aarch64', Runtimes={'nvidia': {}},
                                DockerRootDir='/var/lib/docker'), compose='2.39.1', gpu='NVIDIA GB10',
                    kvm=True, timestamp=1792828800)

    def test_capabilities_not_a_copy_of_developer_versions(self):
        for version in ('2.39.1', '2.40.3'):
            facts = self.facts()
            facts['compose'] = version
            installer.validate_host_facts(release_fixture(), facts)

    def test_unsupported_foundation_never_repaired(self):
        for field, value, error in [('platform', 'darwin', 'Linux ARM64'),
                                    ('architecture', 'x86_64', 'Linux ARM64'),
                                    ('uid', 1000, 'sudo'), ('os', 'ubuntu:22.04', 'factory OS'),
                                    ('kvm', False, 'KVM'), ('gpu', 'Other GPU', 'GB10'),
                                    ('compose', '', 'Compose'), ('timestamp', 0, 'clock')]:
            facts = self.facts()
            facts[field] = value
            with self.subTest(field=field), self.assertRaisesRegex(InstallError, error), patch.object(installer, 'run') as command:
                installer.validate_host_facts(release_fixture(), facts)
                command.assert_not_called()
        facts = self.facts()
        facts['docker']['Runtimes'] = {}
        with self.assertRaisesRegex(InstallError, 'NVIDIA Docker'):
            installer.validate_host_facts(release_fixture(), facts)

    def test_preflight_is_read_only_and_rejects_owned_containers(self):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            root = Path(temp) / 'new'
            stack.enter_context(patch.object(installer.sys, 'platform', 'linux'))
            stack.enter_context(patch.object(installer.platform, 'machine', return_value='aarch64'))
            stack.enter_context(patch.object(installer.os, 'geteuid', return_value=0))
            stack.enter_context(patch.object(installer, 'host_facts', return_value=self.facts()))
            stack.enter_context(patch.object(installer, 'existing_installation_guard'))
            stack.enter_context(patch.object(installer.socket, 'socket'))
            space = stack.enter_context(patch.object(installer, 'check_space', return_value={}))
            calls = []
            def read(command, **kwargs):
                calls.append(command)
                return ''
            installer.preflight(release_fixture(), root, None, read)
            self.assertFalse(root.exists())
            self.assertEqual([c[1:3] for c in calls], [['ps', '-aq'], ['image', 'ls']])
            space.assert_called_once()
            with self.assertRaisesRegex(InstallError, 'unregistered Team'):
                installer.preflight(release_fixture(), root, None, lambda *a, **k: 'original-container')
            self.assertFalse(root.exists())


class LifecycleTests(unittest.TestCase):
    def test_image_import_precedes_new_volume_capacity_calculation(self):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            directory = Path(temp)
            package, root, _ = self.harness(stack, directory)
            calls = []
            stack.enter_context(patch.object(installer, 'import_images', side_effect=lambda *a: calls.append('images')))
            stack.enter_context(patch.object(installer, 'execute_phase', side_effect=lambda s, r: calls.append(s['phase'])))
            installer.install(package, root, lock_path=directory / 'lock')
            self.assertEqual(calls[:2], ['images', 'storage'])

    def harness(self, stack, directory):
        package, root = directory / 'package', directory / 'new'
        package.mkdir()
        manifest = release_fixture()
        write_json(package / 'release.json', manifest)
        stack.enter_context(patch.object(installer, 'verify_package', return_value=manifest))
        stack.enter_context(patch.object(installer, 'preflight', return_value={'hostPackages': 0}))
        stack.enter_context(patch.object(installer, 'existing_installation_guard'))
        for name in ('install_host_packages', 'install_runtime', 'import_images', 'install_assets', 'wait_ready'):
            stack.enter_context(patch.object(installer, name))
        return package, root, manifest

    def test_read_only_check_creates_no_lock_or_installation(self):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            directory = Path(temp)
            package, root, _ = self.harness(stack, directory)
            lock = directory / 'install.lock'
            result = installer.install(package, root, check=True, lock_path=lock)
            self.assertFalse(root.exists())
            self.assertFalse(lock.exists())
            self.assertFalse(result['installed'])

    def test_resume_after_import_and_catalog_preserves_identity_and_data(self):
        # Test failures at separate stages. Earlier valid phases are checked,
        # not reapplied; every retry retains the same installation and data.
        for failed_phase in ('configuration', 'catalog', 'recovery'):
            with self.subTest(phase=failed_phase), tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
                directory = Path(temp)
                package, root, manifest = self.harness(stack, directory)
                applied, checked = [], []
                failed = [False]
                def phase(step, target):
                    checked.append(step['phase'])
                    marker = target / (step['phase'] + '.fixture')
                    if marker.exists():
                        return
                    if step['phase'] == failed_phase and not failed[0]:
                        failed[0] = True
                        raise InstallError('injected installation interruption')
                    marker.write_text('new-installation-data')
                    applied.append(step['phase'])
                stack.enter_context(patch.object(installer, 'execute_phase', side_effect=phase))
                with self.assertRaisesRegex(InstallError, 'interruption'):
                    installer.install(package, root, lock_path=directory / 'lock')
                before = read_json(root / 'install-state.json')
                self.assertEqual(before['status'], 'incomplete')
                (root / 'sentinel').write_text('preserve')
                result = installer.install(package, root, lock_path=directory / 'lock')
                after = read_json(root / 'install-state.json')
                self.assertEqual(result['status'], 'installed')
                self.assertEqual(before['installationId'], after['installationId'])
                self.assertEqual(before['nodeId'], after['nodeId'])
                self.assertEqual((root / 'sentinel').read_text(), 'preserve')
                self.assertEqual(applied, [s['phase'] for s in manifest['steps']])
                read_calls = []
                stack.enter_context(patch.object(installer, 'run', side_effect=lambda a, **k: read_calls.append(a)))
                result = installer.install(package, root, lock_path=directory / 'lock')
                self.assertEqual(result['status'], 'unchanged')
                self.assertEqual(len(read_calls), len(manifest['steps']))
                self.assertTrue(all('--check' in call for call in read_calls))

    def test_parallel_installer_does_not_create_state(self):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            directory = Path(temp)
            package, root, _ = self.harness(stack, directory)
            with (directory / 'lock').open('a') as first:
                fcntl.flock(first, fcntl.LOCK_EX | fcntl.LOCK_NB)
                with self.assertRaisesRegex(InstallError, 'another installation'):
                    installer.install(package, root, lock_path=directory / 'lock')
            self.assertFalse(root.exists())

    def test_changed_package_cannot_resume_same_named_release(self):
        with tempfile.TemporaryDirectory() as temp, ExitStack() as stack:
            directory = Path(temp)
            package, root, manifest = self.harness(stack, directory)
            stack.enter_context(patch.object(installer, 'execute_phase', side_effect=InstallError('interrupted')))
            with self.assertRaises(InstallError):
                installer.install(package, root, lock_path=directory / 'lock')
            before = (root / 'install-state.json').read_bytes()
            write_json(package / 'release.json', {**manifest, 'changed': True})
            with self.assertRaisesRegex(InstallError, 'package changed'):
                installer.install(package, root, lock_path=directory / 'lock')
            self.assertEqual((root / 'install-state.json').read_bytes(), before)


if __name__ == '__main__':
    unittest.main()

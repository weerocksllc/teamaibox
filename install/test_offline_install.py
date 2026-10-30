"""Installation-only checks. Uses temporary fixtures; never touches appliance data."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import factory_bootstrap as factory
import installer
import package
import offline_host_packages
from offline_common import ASSET_ROLES, IMAGE_ROLES, PHASES, InstallError, atomic, digest, read_json, validate_factory, validate_release, verify_package, within, write_json


def release_fixture():
    image = 'sha256:' + 'a' * 64
    return dict(schemaVersion=1, releaseId='test-offline', sourceCommit='b' * 40, architecture='arm64',
                agentVersion='1.0.0', guestSystems=dict(androidBaseBuildId='16102939', androidVersion='17',
                                                     cameraSources=['image', 'browser', 'video', 'usb', 'udp']),
                host=dict(os=['ubuntu:24.04'], commands=['docker', 'python3', 'openssl'], freeReserveBytes=0),
                images=[dict(role=r, reference=image, imageId=image, architecture='arm64') for r in sorted(IMAGE_ROLES)],
                assets=[dict(role=r, source=r, destination='assets/' + r, files=[dict(path='asset', sha256=hashlib.sha256(b'data').hexdigest(), size=4)]) for r in sorted(ASSET_ROLES)],
                runtimeFiles=['tools/phase.py'],
                steps=[dict(phase=p, apply=['python3', 'tools/phase.py', p], check=['python3', 'tools/phase.py', p, '--check'], timeoutSeconds=10) for p in PHASES],
                readiness=[dict(role=r, timeoutSeconds=10) for r in ('platform-api', 'web', 'node-agent', 'assistant-worker', 'drawing-worker', 'ocr-worker', 'asr-worker', 'translation-worker', 'embedding-worker')])


def factory_fixture():
    outputs = ['compose.json', 'installation.env', 'phones.json', 'addresses.json', 'frontdoor.json', 'network.json']
    return dict(schemaVersion=1,
                directories=[dict(path='database', uid=999, gid=999, mode='0700')],
                secrets=[dict(name='test-secret', path='secrets/test', format='base64url', bytes=32)],
                templates=[dict(input=n, output=n, format='env' if n.endswith('.env') else 'json') for n in outputs],
                composeFile='compose.json', composeEnvironment='installation.env',
                references=dict(composeFile='compose.json', composeEnvironment='installation.env', phones='phones.json',
                                publicAddresses='addresses.json', frontdoor='frontdoor.json', networkIdentity='network.json'),
                officeDefinition='compose.json',
                services={'core': dict(names=['platform-api'], roles={'platform-api': 'platform-api'}, timeoutSeconds=10)},
                catalog=dict(apply=[['python3', 'tools/phase.py']], check=[['python3', 'tools/phase.py']], timeoutSeconds=10),
                recovery=dict(apply=[['python3', 'tools/phase.py']], check=[['python3', 'tools/phase.py']], timeoutSeconds=10))


class ContractTests(unittest.TestCase):
    def test_complete_release_contract(self):
        validate_release(release_fixture())

    def test_missing_deferred_image(self):
        value = release_fixture()
        value['images'] = [r for r in value['images'] if r['role'] != 'phone-runtime']
        with self.assertRaisesRegex(InstallError, 'phone-runtime'):
            validate_release(value)

    def test_wrong_architecture(self):
        value = release_fixture()
        value['images'][0]['architecture'] = 'amd64'
        with self.assertRaisesRegex(InstallError, 'architecture'):
            validate_release(value)

    def test_unpinned_image(self):
        value = release_fixture()
        value['images'][0]['imageId'] = 'latest'
        with self.assertRaisesRegex(InstallError, 'content ID'):
            validate_release(value)

    def test_missing_model_inventory(self):
        value = release_fixture()
        value['assets'][0]['files'] = []
        with self.assertRaisesRegex(InstallError, 'inventory'):
            validate_release(value)

    def test_overlapping_assets(self):
        value = release_fixture()
        value['assets'][0]['destination'] = value['assets'][1]['destination'] + '/inside'
        with self.assertRaisesRegex(InstallError, 'overlapping'):
            validate_release(value)

    def test_traversal_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            for path in ('../bad', '/etc/passwd', 'x/../../bad', './x', 'x//y'):
                with self.subTest(path=path), self.assertRaises(InstallError):
                    within(Path(temp), path)

    def test_symlink_ancestor_rejected(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'link').symlink_to('/tmp')
            with self.assertRaisesRegex(InstallError, 'symlink'):
                within(root, 'link/nonexistent')

    def test_recipe_cannot_omit_registration(self):
        recipe = factory_fixture()
        recipe['catalog']['apply'] = []
        with self.assertRaisesRegex(InstallError, 'catalog'):
            validate_factory(recipe, {r['input'] for r in recipe['templates']}, ['tools/phase.py'])

    def test_recipe_cannot_use_external_script(self):
        recipe = factory_fixture()
        recipe['recovery']['apply'] = [['bash', '/tmp/old-script.sh']]
        with self.assertRaisesRegex(InstallError, 'bundled'):
            validate_factory(recipe, {r['input'] for r in recipe['templates']}, ['tools/phase.py'])


class SafetyTests(unittest.TestCase):
    def test_broad_or_symlink_root_rejected(self):
        for name in ('/', '/srv', '/etc/teamaibox', '/srv/teamaibox/data', '/srv/x/../data'):
            with self.subTest(name=name), self.assertRaises(InstallError):
                installer.safe_root(name)
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp).resolve()
            (base / 'link').symlink_to(base, target_is_directory=True)
            with self.assertRaisesRegex(InstallError, 'symlink'):
                installer.safe_root(base / 'link' / 'missing')

    def test_other_version_is_not_an_upgrade(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            value = release_fixture()
            state = dict(schemaVersion=1, root=str(root), releaseId='other', sourceCommit=value['sourceCommit'])
            write_json(root / 'install-state.json', state)
            before = (root / 'install-state.json').read_bytes()
            with self.assertRaisesRegex(InstallError, 'upgrade entry'):
                installer.read_state(root, value)
            self.assertEqual((root / 'install-state.json').read_bytes(), before)

    def test_unregistered_data_preserved(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'keep').write_text('existing customer data')
            with self.assertRaisesRegex(InstallError, 'unregistered'):
                installer.read_state(root, release_fixture())
            self.assertEqual((root / 'keep').read_text(), 'existing customer data')

    def test_existing_installation_guard(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            write_json(root / 'record.json', dict(installationId='original', nodeId='original'))
            with self.assertRaisesRegex(InstallError, 'existing Team'):
                installer.existing_installation_guard(root, None, root / 'record.json')

    def test_asset_resume_and_no_overwrite(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            src, dst = root / 'src', root / 'dst'
            src.write_bytes(b'model bytes')
            info = dict(size=src.stat().st_size, sha256=digest(src))
            installer.stream_copy(src, dst, info)
            stamp = dst.stat().st_mtime_ns
            installer.stream_copy(src, dst, info)
            self.assertEqual(dst.stat().st_mtime_ns, stamp)
            dst.write_bytes(b'keep original')
            with self.assertRaisesRegex(InstallError, 'refusing overwrite'):
                installer.stream_copy(src, dst, info)
            self.assertEqual(dst.read_bytes(), b'keep original')

    def test_damaged_copy_not_published(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'src').write_bytes(b'x')
            with self.assertRaisesRegex(InstallError, 'integrity'):
                installer.stream_copy(root / 'src', root / 'dst', dict(size=2, sha256='0' * 64))
            self.assertFalse((root / 'dst').exists())

    def test_interrupted_copy_resumes_without_altering_completed_assets(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            src, dst = root / 'source', root / 'target'
            src.write_bytes(b'released artifact')
            (root / '.target.installing').write_bytes(b'partial')
            (root / 'keep').write_text('customer sentinel')
            installer.stream_copy(src, dst, dict(size=src.stat().st_size, sha256=digest(src)))
            self.assertEqual(src.read_bytes(), dst.read_bytes())
            self.assertEqual((root / 'keep').read_text(), 'customer sentinel')

    def test_healthy_components_are_reported_even_when_another_times_out(self):
        now = [0]
        calls = []
        def runner(args, **kwargs):
            calls.append(args)
            if 'ps' in args:
                return 'web-id' if args[-1].endswith('=web') else ''
            return json.dumps([dict(State=dict(Running=True, Health=dict(Status='healthy')))])
        with tempfile.TemporaryDirectory() as temp:
            report = Path(temp) / 'report.json'
            with self.assertRaisesRegex(InstallError, 'assistant-worker'):
                installer.wait_ready(dict(readiness=[dict(role='assistant-worker', timeoutSeconds=1), dict(role='web', timeoutSeconds=1)]),
                                     dict(installationId='fixture'), runner, clock=lambda: now[0],
                                     sleep=lambda value: now.__setitem__(0, now[0] + value), report_path=report)
            self.assertEqual(read_json(report)['components'], {'assistant-worker': 'failed', 'web': 'ready'})
        self.assertFalse(any(set(c) & {'restart', 'start', 'stop', 'rm', 'pull'} for c in calls))

    def test_host_package_transaction_forbids_foundation_replacement(self):
        for value in ('Inst nvidia-container-toolkit (1.0 local)', 'Inst undeclared (1.0 local)', 'Remv libc6'):
            with self.subTest(value=value), self.assertRaises(InstallError):
                offline_host_packages.validate_transaction(value, {'tool'})
        offline_host_packages.validate_transaction('Inst tool (1.0 local)', {'tool'})

    def test_missing_offline_dependency_has_no_online_fallback(self):
        calls = []
        def runner(args, **kwargs):
            calls.append(args)
            if args[0] == 'dpkg-deb':
                return 'Package: tool\nVersion: 1\nArchitecture: arm64\nDescription: Test tool\n'
            if 'update' in args:
                source = next(v.split('=', 1)[1] for v in args if v.startswith('Dir::Etc::sourcelist='))
                self.assertRegex(Path(source).read_text(), r'^deb \[trusted=yes\] file:')
                return ''
            raise InstallError('offline package dependency missing')
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'tool.deb'
            path.write_bytes(b'fixture package')
            rows = [dict(source=str(path), sha256=digest(path))]
            with self.assertRaisesRegex(InstallError, 'dependency missing'):
                offline_host_packages.install(rows, ['tool'], runner, lambda name: False)
        self.assertEqual(len(calls), 3)
        self.assertIn('--simulate', calls[-1])
        self.assertIn('--no-download', calls[-1])

    def test_existing_host_tools_do_not_upgrade_dependency_inventory(self):
        with patch.object(offline_host_packages, 'run') as runner:
            result = offline_host_packages.install([], ['tool'], runner, lambda name: True)
            runner.assert_not_called()
            self.assertEqual(result['installed'], [])

    def test_failed_phase_resumes_only_that_phase(self):
        calls = []
        step = dict(phase='catalog', apply=['python3', 'tools/phase.py', 'catalog'],
                    check=['python3', 'tools/phase.py', 'catalog', '--check'], timeoutSeconds=10)
        with patch.object(installer.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)):
            installer.execute_phase(step, Path('/srv/fixture'), lambda args, **kwargs: calls.append(args))
        self.assertEqual(len(calls), 2)
        self.assertNotIn('--check', calls[0])
        self.assertIn('--check', calls[1])
        self.assertTrue(all('catalog' in c for c in calls))

    def test_same_disk_space_is_aggregated(self):
        value = release_fixture()
        for row in value['images']:
            row['unpackedBytes'] = 100
        value['files'] = {}
        with patch.object(installer, 'filesystem', return_value=(1, 110)):
            with self.assertRaisesRegex(InstallError, 'space'):
                installer.check_space(value, '/data', '/docker')

    def test_assets_require_mounted_data(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(InstallError, 'plaintext'):
                installer.install_assets(release_fixture(), Path(temp), Path(temp))

    def test_resume_space_only_charges_missing_verified_resources(self):
        value = release_fixture()
        for row in value['images']:
            row['unpackedBytes'] = 100
        value['files'] = {}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for asset in value['assets']:
                target = root / 'data' / asset['destination'] / 'asset'
                target.parent.mkdir(parents=True)
                target.write_bytes(b'data')
            image = value['images'][0]['imageId']
            self.assertEqual(installer.required_space(value, root, {image}), (0, 0))
            target.unlink()
            self.assertEqual(installer.required_space(value, root, {image}), (0, 4))
            target.write_bytes(b'evil')
            with self.assertRaisesRegex(InstallError, 'preserved'):
                installer.required_space(value, root, {image})

    def test_factor_reused_and_unique(self):
        with tempfile.TemporaryDirectory() as temp:
            a, b = Path(temp) / 'a', Path(temp) / 'b'
            factory.create_factor(a, 64)
            original = a.read_bytes()
            factory.create_factor(a, 64)
            factory.create_factor(b, 64)
            self.assertEqual(original, a.read_bytes())
            self.assertNotEqual(original, b.read_bytes())
            self.assertEqual(a.stat().st_mode & 0o777, 0o600)

    def test_unknown_template_token_is_error(self):
        with self.assertRaisesRegex(InstallError, 'unknown factory'):
            factory.expand({'path': '@@DEVELOPER_PATH@@'}, {})
        self.assertEqual(factory.expand({'path': '@@DATA@@/models'}, {'DATA': '/local/data'}), {'path': '/local/data/models'})

    def test_storage_only_formats_new_owned_image_and_reuses_registered_identity(self):
        import restore_existing_business_volumes as restore_module
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            write_json(root / 'install-state.json', {'installationId': '12345678-1234-4234-8234-123456789abc'})
            value = release_fixture()
            value['host']['freeReserveBytes'] = 128 * 1024**2
            write_json(root / 'release.json', value)
            calls = []
            def run(args, **kwargs):
                calls.append(args)
                plan = read_json(root / 'storage-create.json')
                if args[:2] == ['cryptsetup', 'luksUUID']: return plan['luksUuid']
                if args[:2] == ['cryptsetup', 'status']: return 'device: /dev/loop123'
                if args[0] == 'losetup': return json.dumps({'loopdevices': [{'back-file': str(root / 'volume/data.img')}]})
                if args[0] == 'blkid': return plan['fsUuid']
                return ''
            with patch.object(factory, 'run', side_effect=run), patch.object(factory.shutil, 'disk_usage', return_value=SimpleNamespace(free=2 * 1024**3)), patch.object(restore_module, 'restore') as restore, patch.object(factory.os, 'chown') as chown:
                factory.storage(root)
                before = (root / 'storage-volumes.json').read_bytes()
                key = (root / 'volume/automatic.key').read_bytes()
                factory.storage(root)
                self.assertEqual((root / 'storage-volumes.json').read_bytes(), before)
                self.assertEqual((root / 'volume/automatic.key').read_bytes(), key)
                self.assertEqual(restore.call_count, 2)
                chown.assert_any_call(root / 'data', 0, 10001)
                chown.assert_any_call(root / 'data/volumes', 10001, 10001)
            self.assertEqual(sum(args[:2] == ['cryptsetup', 'luksFormat'] for args in calls), 1)
            self.assertEqual(sum(args[0] == 'mkfs.ext4' for args in calls), 1)
            self.assertEqual(read_json(root / 'storage-create.json')['size'], 2 * 1024**3 - 128 * 1024**2)

    def test_storage_preserves_an_unregistered_image(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            write_json(root / 'install-state.json', {'installationId': '12345678-1234-4234-8234-123456789abc'})
            (root / 'volume').mkdir()
            (root / 'volume/data.img').write_bytes(b'previous data')
            with patch.object(factory, 'run') as run:
                with self.assertRaisesRegex(InstallError, 'unregistered storage'):
                    factory.storage(root)
                run.assert_not_called()
            self.assertEqual((root / 'volume/data.img').read_bytes(), b'previous data')
            self.assertFalse((root / 'volume/automatic.key').exists())

    def test_import_image_never_pulls(self):
        calls = []
        row = dict(imageId='sha256:' + 'a' * 64, archive='images/fixture.tar')
        def runner(args, **kwargs):
            calls.append([str(v) for v in args])
            return json.dumps([dict(Id=row['imageId'], Architecture='arm64')]) if 'inspect' in args else ''
        with tempfile.TemporaryDirectory() as temp:
            with patch.object(installer.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)):
                installer.import_images({'images': [row, row]}, Path(temp).resolve(), runner)
        self.assertEqual(sum('load' in v for v in calls), 1)
        self.assertFalse(any('pull' in v for v in calls))

    def test_successful_phase_not_reapplied(self):
        step = dict(phase='core', apply=['python3', 'tools/phase.py', 'apply'], check=['python3', 'tools/phase.py', 'check'], timeoutSeconds=10)
        calls = []
        with patch.object(installer.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)):
            installer.execute_phase(step, Path('/tmp/fixture'), lambda args, **kwargs: calls.append(args))
        self.assertEqual(len(calls), 1)
        self.assertIn('check', calls[0])
        self.assertNotIn('apply', calls[0])


class PackageTests(unittest.TestCase):
    def test_runtime_closure_includes_shared_host_modules(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            (root / 'install').mkdir()
            (root / 'tools').mkdir()
            (root / 'install/entry.py').write_text('from restore import run\n')
            (root / 'tools/restore.py').write_text('from helpers import identity\n')
            (root / 'tools/helpers.py').write_text('identity = "fixture"\n')
            self.assertEqual(package.module_closure(root, ['install/entry.py']),
                             ['install/entry.py', 'tools/helpers.py', 'tools/restore.py'])

    def make_inputs(self, root):
        repo = root / 'repo'
        repo.mkdir()
        subprocess.run(['git', 'init', '-q', repo], check=True)
        (repo / 'tools').mkdir()
        (repo / 'tools/phase.py').write_text('print("fixture only")\n')
        (repo / 'install').mkdir()
        for name in package.INSTALL_FILES:
            shutil.copyfile(Path(__file__).parent / name, repo / 'install' / name)
        for name in package.LEGAL_FILES:
            target = repo / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(Path(__file__).resolve().parents[1] / name, target)
        subprocess.run(['git', '-C', repo, 'add', '.'], check=True)
        subprocess.run(['git', '-C', repo, '-c', 'user.name=Installer Test', '-c', 'user.email=installer@example.invalid',
                        'commit', '-qm', 'fixture'], check=True)
        value = release_fixture()
        value['sourceCommit'] = subprocess.check_output(['git', '-C', repo, 'rev-parse', 'HEAD'], text=True).strip()
        for asset in value['assets']:
            directory = root / asset['source']
            directory.mkdir()
            if asset['role'] == 'factory-configuration':
                recipe = factory_fixture()
                write_json(directory / 'factory.json', recipe)
                for row in recipe['templates']:
                    write_json(directory / row['input'], {})
                asset['files'] = package.inventory_asset(directory, asset['destination'], asset['role'])['files']
            else:
                from test_artifact_validation import asset_fixture
                asset_fixture(directory, asset['role'])
                asset['files'] = package.inventory_asset(directory, asset['destination'], asset['role'])['files']
        write_json(root / 'input.json', value)
        return repo, value

    def runner(self, args, **kwargs):
        if args[0] == 'docker':
            if 'inspect' in args:
                return json.dumps([dict(Id='sha256:' + 'a' * 64, Architecture='arm64', Os='linux', Size=20)])
            if 'save' in args:
                kwargs['stdout'].write(b'fake archive for package logic only')
                return ''
            raise AssertionError(args)
        return package.run(args, **kwargs)

    def test_build_verify_and_tamper(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo, value = self.make_inputs(root)
            result = package.build(root / 'input.json', root / 'output', repo, self.runner)
            extracted = root / 'output' / ('teamaibox-' + value['releaseId'] + '-linux-arm64')
            manifest = verify_package(extracted)
            self.assertFalse(result['installed'])
            self.assertEqual(len({i['archive'] for i in manifest['images']}), 1)
            self.assertNotIn('source', manifest['assets'][0])
            (extracted / 'install.sh').write_text('tampered')
            with self.assertRaisesRegex(InstallError, 'damaged'):
                verify_package(extracted)

    def test_missing_asset_never_publishes(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo, value = self.make_inputs(root)
            asset = next(a for a in value['assets'] if a['role'] == 'assistant-model')
            (root / asset['source'] / 'asset').unlink()
            with self.assertRaises(InstallError):
                package.build(root / 'input.json', root / 'output', repo, self.runner)
            self.assertEqual(list((root / 'output').iterdir()), [])

    def test_customer_entrypoint_does_not_mutate_verified_package(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo, value = self.make_inputs(root)
            package.build(root / 'input.json', root / 'output', repo, self.runner)
            extracted = root / 'output' / ('teamaibox-' + value['releaseId'] + '-linux-arm64')
            before = sorted(str(path.relative_to(extracted)) for path in extracted.rglob('*'))
            for _ in range(2):
                subprocess.run(['bash', str(extracted / 'install.sh'), '--verify-package'],
                               check=True, capture_output=True, text=True)
            self.assertEqual(before, sorted(str(path.relative_to(extracted)) for path in extracted.rglob('*')))
            self.assertFalse(list(extracted.rglob('__pycache__')))

    def test_dirty_runtime_is_not_silently_packaged(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo, _ = self.make_inputs(root)
            (repo / 'tools/phase.py').write_text('print("modified")\n')
            with self.assertRaisesRegex(InstallError, 'source commit'):
                package.build(root / 'input.json', root / 'output', repo, self.runner)

    def test_explicit_worktree_build_remains_a_candidate(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo, value = self.make_inputs(root)
            # These fixture images are not executable app images; this test
            # isolates provenance metadata from the separate OCI role guard.
            with patch('package.verify_application_role'):
                package.build(root / 'input.json', root / 'output', repo, self.runner, allow_working_tree=True)
            extracted = root / 'output' / ('teamaibox-' + value['releaseId'] + '-linux-arm64')
            self.assertTrue(verify_package(extracted)['candidate'])

    def test_dirty_installer_is_not_silently_labelled_as_release_commit(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            repo, _ = self.make_inputs(root)
            (repo / 'install/installer.py').write_text('# candidate changed\n')
            with self.assertRaisesRegex(InstallError, 'source commit'):
                package.build(root / 'input.json', root / 'output', repo, self.runner)


if __name__ == '__main__':
    unittest.main()

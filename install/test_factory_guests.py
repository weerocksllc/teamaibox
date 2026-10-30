import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from factory_guests import configurations, cpu_groups, prepare_mountpoints
from offline_common import InstallError


ROOT = Path(__file__).resolve().parents[1]


def fixture():
    release = dict(images=[dict(role=role, imageId='sha256:' + char * 64) for role, char in
                           [('phone-runtime', 'a'), ('phone-google-runtime', 'b'), ('computer-runtime', 'c')]],
        assets=[dict(role=role, destination='assets/' + role, files=[dict(path=p, sha256='d' * 64) for p in paths])
                for role, paths in [('computer-firmware', ['CODE.fd', 'VARS.fd']), ('computer-drivers', ['virtio.iso'])]],
        guestSystems=dict(androidVersion='17', androidBaseBuildId='16102939', cameraSources=['image', 'browser', 'video', 'usb', 'udp']),
        host=dict(freeReserveBytes=16 * 1024**3))
    return configurations(Path('/srv/teamaibox/installation'), dict(nodeId='12345678-1234-4234-8234-123456789abc'),
                          release, 'pool-12345678', groups=[[0, 1], [2, 3]], kvm_group=108, vhost_group=109)


class GuestFactoryTests(unittest.TestCase):
    def test_nested_installer_mountpoint_prepared_without_an_iso(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);media=root/'data/assets/drivers';media.mkdir(parents=True)
            release={'assets':[dict(role='computer-drivers',destination='assets/drivers')]}
            prepare_mountpoints(root,release);prepare_mountpoints(root,release)
            self.assertTrue((media/'installer').is_dir())
            (media/'installer/user.iso').write_bytes(b'preserve')
            with self.assertRaisesRegex(InstallError,'remain empty'):
                prepare_mountpoints(root,release)
            self.assertEqual((media/'installer/user.iso').read_bytes(),b'preserve')

    def test_guest_paths_match_storage_pool_volume_root(self):
        values = fixture()
        for kind in ('phones', 'computers'):
            self.assertEqual(values[kind]['dataRoot'], '/srv/teamaibox/installation/data/volumes')
        policy = values['computerApi']['installedNodes'][0]['policy']
        self.assertEqual(policy['storageReserveBytes'], 8 * 1024**3)
        self.assertIn('const marginBytes uint64 = 8 << 30',
                      (ROOT / 'services/node-agent/internal/phonepool/pool.go').read_text())

    def test_generated_phone_and_computer_configs_pass_existing_parsers(self):
        values = fixture()
        script = """
import {phoneApprovedNodes} from './services/scheduler/src/phone-approved-nodes.mjs';
import {computerConfiguration} from './apps/platform-api/src/virtual-computers/computer-composition.mjs';
import {profileImport} from './apps/platform-api/src/virtual-computers/computer-profiles.mjs';
let raw='';for await (const chunk of process.stdin)raw+=chunk;
const v=JSON.parse(raw);phoneApprovedNodes(v.approvedPhones);
computerConfiguration({PLATFORM_VIRTUAL_COMPUTERS_CONFIG_JSON:JSON.stringify(v.computerApi)});
for(const profile of v.catalogComputers)profileImport({profile});
console.log('factory guest declarations accepted');
"""
        result = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT,
                                input=json.dumps(values), capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr[-3000:])

    def test_no_source_machine_or_user_guest_state(self):
        values = fixture()
        text = json.dumps(values)
        for token in ('192.168.', 'runtimeMaintenance', 'ownerId', 'volumeId', 'phoneId', 'computerId', 'windows.iso'):
            self.assertNotIn(token, text)
        self.assertEqual(values['phones']['mediaAddress'], '')
        self.assertTrue(values['phones']['hostMediaStateFile'].endswith('/phone-media-state.json'))
        self.assertEqual(values['approvedPhones'][0]['maximumPhones'], None)
        self.assertEqual(set(values['phoneSystems']), {'standard', 'google-play'})
        self.assertTrue(all(p['MediaDigest'] == '' and p['ManagedMedia'] for p in values['computers']['resources']['Profiles']))

    def test_heterogeneous_cpu_groups_come_from_actual_midr(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for number, midr in [(0, '0x410fd8e0'), (1, '0x410fd8e0'), (2, '0x410fd850')]:
                path = root / ('cpu' + str(number)) / 'regs/identification'
                path.mkdir(parents=True)
                (path / 'midr_el1').write_text(midr)
            self.assertEqual(sorted(cpu_groups(root)), [[0, 1], [2]])
            (root / 'cpu2/online').write_text('0')
            self.assertEqual(cpu_groups(root), [[0, 1]])
            (root / 'cpu0/regs/identification/midr_el1').unlink()
            with self.assertRaisesRegex(InstallError, 'CPU core type'):
                cpu_groups(root)


if __name__ == '__main__':
    unittest.main()

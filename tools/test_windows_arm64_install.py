import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from windows_arm64_install_runtime import prepare_guest, qemu_args


class InstallTests(unittest.TestCase):
    def test_ppi_is_explicit_and_never_changes_disk_or_firmware(self):
        old = qemu_args(Path('/guest'), Path('/run'))
        new = qemu_args(Path('/guest'), Path('/run'), 'tis', True)
        self.assertEqual([s.replace('tpm-tis-device,tpmdev=tpmdev', 'tpm-tis-device,tpmdev=tpmdev,id=vtpm,ppi=on') for s in old], new)
        with self.assertRaises(ValueError):
            qemu_args(Path('/guest'), Path('/run'), 'crb', True)

    def test_partial_disk_never_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            (work/'system.qcow2').touch()
            with patch('windows_arm64_install_runtime.subprocess.run') as run:
                with self.assertRaisesRegex(RuntimeError, 'partial persistent guest'):
                    prepare_guest(work)
                run.assert_not_called()

    def test_existing_guest_reused(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            for name in ('system.qcow2', 'VARS.fd'):
                (work/name).touch()
            (work/'tpm').mkdir()
            (work/'identity.json').write_text(json.dumps({'schemaVersion': 1, 'diskGiB': 96, 'diskBus': 'nvme', 'firmware': 'ms', 'tpm': 'tis'}))
            with patch('windows_arm64_install_runtime.subprocess.run') as run, patch('windows_arm64_install_runtime.shutil.copyfile') as cp:
                prepare_guest(work)
                run.assert_not_called()
                cp.assert_not_called()

    def test_disk_firmware_and_tpm_are_persistent(self):
        args = qemu_args(Path('/guest'), Path('/tmp/windows-install'))
        self.assertIn('if=pflash,format=raw,file=/guest/VARS.fd', args)
        self.assertIn('if=none,id=system,format=qcow2,cache=none,aio=threads,file=/guest/system.qcow2', args)
        self.assertIn('tpm-tis-device,tpmdev=tpmdev', args)
        self.assertIn('kvm', args)
        self.assertNotIn('tcg', args)
        self.assertIn('127.0.0.1:0', args)
        self.assertNotIn('-snapshot', args)

    def test_arm64_driver_media_and_virtio_nic(self):
        args = qemu_args(Path('/guest'), Path('/tmp/windows-install'))
        self.assertIn('virtio-net-pci,netdev=net0,romfile=', args)
        self.assertIn('if=none,id=drivers,format=raw,media=cdrom,readonly=on,cache=none,file=/media/virtio.iso', args)
        self.assertNotIn('usb-net,netdev=net0', args)

    def test_crb_selection_keeps_machine_and_storage(self):
        old = qemu_args(Path('/guest'), Path('/run'))
        new = qemu_args(Path('/guest'), Path('/run'), 'crb')
        self.assertEqual([s.replace('tpm-tis-device', 'tpm-crb-device') for s in old], new)
        with self.assertRaises(ValueError):
            qemu_args(Path('/guest'), Path('/run'), 'none')

    def test_interface_change_requires_explicit_offline_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            work = Path(directory)
            for name in ('system.qcow2', 'VARS.fd'):
                (work/name).touch()
            (work/'tpm').mkdir()
            (work/'identity.json').write_text(json.dumps({'schemaVersion': 1, 'diskGiB': 96, 'diskBus': 'nvme', 'firmware': 'ms', 'tpm': 'tis'}))
            with self.assertRaisesRegex(RuntimeError, 'format differs'):
                prepare_guest(work, 'crb')

    def test_thp_is_process_scoped(self):
        from windows_arm64_install_runtime import disable_process_thp
        with patch('windows_arm64_install_runtime.ctypes.CDLL') as lib:
            lib.return_value.prctl.side_effect = [0, 1]
            disable_process_thp()
            self.assertEqual(lib.return_value.prctl.call_args_list[0].args, (41, 1, 0, 0, 0))


if __name__ == '__main__':
    unittest.main()

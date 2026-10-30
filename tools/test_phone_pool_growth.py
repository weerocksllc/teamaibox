import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('growth', ROOT/'deploy/android/cuttlefish/phone_pool_growth.py')
g = importlib.util.module_from_spec(spec); spec.loader.exec_module(g)


class GrowthTests(unittest.TestCase):
    def test_capacity_configurable_not_fixed_64(self):
        for size in (64, 128, 256, 512, 1024): g.validate_capacity(64*g.GIB, size*g.GIB)

    def test_reject_shrink_fraction_and_unbounded(self):
        for before, after in ((64, 32), (64, 65), (64, 16385), (32, 256)):
            with self.assertRaises(g.original.PoolError): g.validate_capacity(before*g.GIB, after*g.GIB)
        with self.assertRaises(g.original.PoolError): g.validate_capacity(64*g.GIB, 256.0*g.GIB)

    def test_no_physical_device_resize(self):
        with self.assertRaises(g.original.PoolError): g.grow_mapping(Path('/not/opened'), 'pool', '/dev/nvme0n1', 1, -1)

    def test_backing_mismatch_no_file_open(self):
        with patch.object(g, 'command', return_value='/another/file'), patch.object(g.os, 'open') as opened:
            with self.assertRaises(g.original.PoolError): g.grow_mapping(Path('/expected'), 'pool', '/dev/loop20', 1, -1)
            opened.assert_not_called()

    def test_interrupted_growth_accepts_only_authorized_range(self):
        with tempfile.TemporaryDirectory() as d:
            file = Path(d).resolve()/'pool'; file.touch(); file.write_bytes(b'0'*80)
            p = dict(minimumCapacityBytes=64, capacityBytes=256)
            with patch.object(g.original, 'paths', return_value=(None, file, None, None)):
                self.assertEqual(g.actual_plan(p)['capacityBytes'], 80)
                file.write_bytes(b'0'*257)
                with self.assertRaises(g.original.PoolError): g.actual_plan(p)

    def test_grow_order_never_format_or_shrink(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d)/'file'; path.write_bytes(b'0'*4096)
            with path.open('rb') as key:
                commands=[]
                def command(args, **kwargs):
                    commands.append(args)
                    return str(path) if args[0]=='losetup' and '-O' in args else ''
                def allocate(fd, offset, length):
                    self.assertEqual(offset,4096); self.assertEqual(length,4096)
                    import os
                    os.lseek(fd, offset, os.SEEK_SET); os.write(fd,b'1'*length)
                with patch.object(g, 'command', side_effect=command), patch.object(g.os,'posix_fallocate',side_effect=allocate,create=True):
                    g.grow_mapping(path,'testpool','/dev/loop20',8192,key.fileno())
                self.assertEqual([a[0] for a in commands],['losetup','losetup','cryptsetup','resize2fs'])
                self.assertEqual(commands[-1],['resize2fs','/dev/mapper/testpool'])

    def test_existing_sparse_extent_does_not_block_growth(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d)/'sparse'; path.touch()
            with path.open('r+b') as stream:
                stream.truncate(16*1024**2)
                commands=[]
                def command(args, **kwargs):
                    commands.append(args)
                    return str(path) if args[0]=='losetup' and '-O' in args else ''
                def allocate(fd, offset, length):
                    import os
                    os.ftruncate(fd, offset+length)
                with patch.object(g, 'command', side_effect=command), patch.object(g.os, 'posix_fallocate', side_effect=allocate, create=True):
                    g.grow_mapping(path,'testpool','/dev/loop20',20*1024**2,stream.fileno())
                self.assertEqual(path.stat().st_size,20*1024**2)
                self.assertEqual(commands[-1],['resize2fs','/dev/mapper/testpool'])


if __name__ == '__main__': unittest.main()

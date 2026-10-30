"""Safety boundaries of the synthetic auxiliary qualification helper."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
SPEC=importlib.util.spec_from_file_location('runtime_qualification',ROOT/'tools/qualify_cuttlefish_phone_runtime.py')
QUAL=importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(QUAL)


class QualificationTests(unittest.TestCase):
    def test_no_caller_supplied_device_or_path(self):
        root,mapper=QUAL.paths('phone-runtime-20260911-a1')
        self.assertEqual(str(root),str(QUAL.BASE/'teamaibox-phone-runtime-20260911-a1'))
        self.assertNotIn('/home/', str(QUAL.BASE))
        self.assertEqual(mapper,'tab-phone-20260911-a1')
        for value in ('/dev/nvme0n1','../disk','phone-runtime-20260911-a1/../../disk','phone-runtime-20260911-a0'):
            with self.assertRaises(ValueError): QUAL.paths(value)

    def test_baseline_fails_before_allocation_on_pressure_and_swap(self):
        good=dict(available=24*1024**3,psi=0,swapout=0)
        for changed in (good|{'available':21*1024**3},good|{'psi':1.1},good|{'swapout':65536}):
            with patch.object(QUAL,'read_host',side_effect=[good,changed]), patch.object(QUAL.time,'sleep'), self.assertRaises(RuntimeError):
                QUAL.baseline()

    def test_exact_image_nonroot_readonly_bounded_no_ports(self):
        source=(ROOT/'tools/qualify_cuttlefish_phone_runtime.py').read_text()
        for fragment in ("'--read-only'","'--user','10001:10001'","'--network','none'",
                         "'--memory-swap','6442450944'","'--cap-drop','ALL'","os.O_EXCL",
                         "loops[0]['back-file']!=str(backing)","'--key-file','-'","'physicalDiskFormatted':False"):
            self.assertIn(fragment,source)
        self.assertNotIn("'--privileged'",source)
        self.assertNotIn("'--publish'",source)
        self.assertNotIn('docker.sock',source)
        self.assertIn("'push','/phone/exchange/qualification.txt'",source)
        self.assertNotIn("'shell','sh','-c'",source)


if __name__=='__main__': unittest.main()

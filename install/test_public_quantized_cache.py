from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from prepare_public_quantized import release_input_cache, unified_memory_arguments
from offline_common import InstallError


class InputCacheTests(unittest.TestCase):
    def test_shared_memory_budget_reserves_capacity_and_rejects_pressure(self):
        args=unified_memory_arguments(['NVIDIA GB10'],'MemTotal: 134217728 kB\nMemAvailable: 125829120 kB\n',52*1024**3)
        self.assertNotIn('--use_seq_device_map',args)
        self.assertLess(float(args[args.index('--max_gpu_memory_gb')+1]),120)
        with self.assertRaises(InstallError):
            unified_memory_arguments(['NVIDIA GB10'],'MemTotal: 134217728 kB\nMemAvailable: 41943040 kB\n',52*1024**3)
        self.assertIn('--use_seq_device_map',unified_memory_arguments(['Other GPU'],'',0))

    def test_advisory_does_not_change_input(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'weights'
            path.write_bytes(b'synthetic model input')
            with patch('prepare_public_quantized.os.posix_fadvise',create=True) as advise, \
                 patch('prepare_public_quantized.os.POSIX_FADV_DONTNEED',4,create=True):
                release_input_cache([path])
                self.assertEqual(advise.call_args.args[1:],(0,0,4))
            self.assertEqual(path.read_bytes(),b'synthetic model input')


if __name__=='__main__':unittest.main()

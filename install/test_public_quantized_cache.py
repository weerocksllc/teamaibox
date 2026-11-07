from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from prepare_public_quantized import finalize_weights, release_input_cache, unified_memory_arguments
from offline_common import InstallError


class InputCacheTests(unittest.TestCase):
    def test_finish_existing_export_keeps_quantized_weights_and_inventories_files(self):
        with tempfile.TemporaryDirectory() as directory:
            source=Path(directory)/'source'; source.mkdir()
            output=Path(directory)/'output'; output.mkdir()
            entries=['config.json','tokenizer_config.json','tokenizer.json','model.safetensors','LICENSE']
            for name in entries:
                (source/name).write_bytes(b'publisher source')
            (output/'config.json').write_bytes(b'exported config')
            (output/'model.safetensors').write_bytes(b'quantized weights')
            files=finalize_weights('assistant',source,output,{'files':[{'path':n} for n in entries]})
            self.assertEqual({row['path'] for row in files},set(entries))
            self.assertTrue(all(len(row['sha256'])==64 for row in files))
            self.assertEqual((output/'model.safetensors').read_bytes(),b'quantized weights')
            self.assertEqual((output/'config.json').read_bytes(),b'exported config')

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

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from worker_hunyuanocr.ocr_runtime import model_options, clean_repeated_substrings


class PublicRuntimeTests(unittest.TestCase):
    def test_offline_options_match_managed_office_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'config.json').touch()
            environment = dict(INFERENCE_MODE='vllm-dflash', DFLASH_MODEL_PATH=directory,
                               MODEL_NAME='example/model', MODEL_REVISION='a' * 40)
            value = model_options(environment)
            self.assertEqual(value['spec_method'], 'dflash')
            self.assertEqual(value['spec_tokens'], 15)
            self.assertEqual(value['kv_cache_memory_bytes'], 1342177280)
            self.assertEqual(value['max_model_len'], 8192)
            self.assertEqual(value['max_num_seqs'], 1)
            with self.assertRaises(RuntimeError):
                model_options(dict(environment, MODEL_LOCAL_FILES_ONLY='false'))
            with self.assertRaises(RuntimeError):
                model_options(dict(environment, DFLASH_NUM_SPECULATIVE_TOKENS='2'))

    def test_missing_model_fails_before_importing_inference_packages(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, 'missing'):
                model_options(dict(INFERENCE_MODE='vllm-dflash', DFLASH_MODEL_PATH=directory))

    def test_existing_output_cleanup_semantics(self):
        self.assertEqual(clean_repeated_substrings('hello'), 'hello')
        self.assertEqual(clean_repeated_substrings('xy' * 4000), 'xy')


if __name__ == '__main__':
    unittest.main()

import hashlib
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
engine=load('managed_dflash_office_engine');patcher=load('patch_office_vllm_cache')

class OfficeWarmupTests(unittest.TestCase):
    def setUp(self):
        engine.INFERENCE_WARMED=False
        self.config=SimpleNamespace(cache_config=SimpleNamespace(kv_cache_memory_bytes=1342177280),
            scheduler_config=SimpleNamespace(max_num_seqs=1),model_config=SimpleNamespace(max_model_len=8192))
        self.runtime=SimpleNamespace(inference_mode='vllm-dflash',model=SimpleNamespace(llm_engine=SimpleNamespace(vllm_config=self.config)))
        self.p=mock.patch.object(engine,'RUNTIME',self.runtime);self.p.start();self.addCleanup(self.p.stop)

    def test_fixed_budget_does_not_reduce_context_or_allow_extra_concurrency(self):
        for obj,key,val in [(self.config.cache_config,'kv_cache_memory_bytes',0),
                            (self.config.scheduler_config,'max_num_seqs',2),
                            (self.config.model_config,'max_model_len',4096)]:
            old=getattr(obj,key);setattr(obj,key,val)
            with self.assertRaisesRegex(RuntimeError,'memory_policy_drift'):engine.warm_inference()
            self.assertFalse(engine.INFERENCE_WARMED);setattr(obj,key,old)

    def test_real_pipeline_called_once_and_temporary_synthetic_input_removed(self):
        seen=[]
        def generate(requests):
            seen.append(requests[0][0]);self.assertTrue(requests[0][0].parent.is_dir())
            return [('TEAM AI BOX READY',self.runtime)]
        pil=SimpleNamespace(Image=mock.MagicMock(),ImageDraw=mock.Mock(),ImageFont=mock.Mock())
        runtime=SimpleNamespace(generate_markdown_batch=generate)
        with mock.patch.dict('sys.modules',{'PIL':pil,'worker_hunyuanocr':mock.Mock(),'worker_hunyuanocr.ocr_runtime':runtime}):
            engine.warm_inference()
        self.assertTrue(engine.INFERENCE_WARMED);self.assertEqual(len(seen),1)
        self.assertFalse(seen[0].parent.exists())

    def test_health_server_not_started_when_warmup_fails(self):
        with mock.patch.object(engine,'load_runtime'),mock.patch.object(engine,'warm_inference',side_effect=RuntimeError('failed')),mock.patch.object(engine,'ThreadingHTTPServer') as server:
            with self.assertRaises(RuntimeError):engine.main()
            server.assert_not_called()

    def test_build_patch_rejects_unknown_upstream_bytes(self):
        with self.assertRaisesRegex(ValueError,'digest_changed'):patcher.patched(b'unknown')

    def test_build_patch_binds_exact_cache_and_one_sequence(self):
        raw=('kwargs={\n'+patcher.ANCHOR+'}\n').encode()
        with mock.patch.object(patcher,'PARENT_SHA256',hashlib.sha256(raw).hexdigest()):
            result=patcher.patched(raw).decode()
        self.assertIn('"kv_cache_memory_bytes": 1342177280',result)
        self.assertIn('"max_num_seqs": 1',result)
        self.assertIn(patcher.ANCHOR,result)

if __name__=='__main__':unittest.main()

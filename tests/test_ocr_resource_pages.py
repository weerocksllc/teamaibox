"""CPU-only regression for page-at-a-time OCR and resource-based admission."""
import importlib.util
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
from services.media_io.resources import buffered_bytes, document_pages

ROOT = Path(__file__).resolve().parents[1]

class ResourcePagesTests(unittest.TestCase):
    def test_budget_follows_actual_memory_and_explicit_admin_quota(self):
        self.assertEqual(buffered_bytes(available=lambda: 8*70*1024**2), 70*1024**2)
        self.assertEqual(buffered_bytes(available=lambda: 160), 20)
        self.assertEqual(buffered_bytes(available=lambda: 160, configured='10'), 10)
        self.assertEqual(buffered_bytes(available=lambda: 0), 0)

    def test_render_more_than_100_pages_one_at_a_time_and_cleanup(self):
        calls=[]
        class Document:
            page_count=101
            def __enter__(self): return self
            def __exit__(self,*_): pass
        with tempfile.TemporaryDirectory() as folder:
            workspace=Path(folder)
            def render(source, metadata):
                self.assertFalse((workspace/'page.png').exists())
                self.assertEqual(metadata['page_start'],metadata['page_end'])
                calls.append(metadata['page_start'])
                return [types.SimpleNamespace(image_data=b'synthetic')]
            modules={'fitz':types.SimpleNamespace(open=lambda _:Document()),
                'worker_hunyuanocr':types.ModuleType('worker_hunyuanocr'),
                'worker_hunyuanocr.pdf_pages':types.SimpleNamespace(render_pdf_pages=render)}
            with patch.dict(sys.modules,modules):
                pages=document_pages(workspace/'source.pdf',workspace,pdf=True)
                self.assertEqual(sum(path.read_bytes()==b'synthetic' for path in pages),101)
                self.assertEqual(calls,list(range(101)))
                pages=document_pages(workspace/'source.pdf',workspace,pdf=True)
                next(pages);pages.close()
                self.assertFalse((workspace/'page.png').exists())

    def test_real_vendor_101_page_pdf_when_available(self):
        try:
            import fitz
            import worker_hunyuanocr.pdf_pages
        except ImportError:
            self.skipTest('real renderer is tested inside the ARM64 runtime image')
        with tempfile.TemporaryDirectory() as folder:
            workspace=Path(folder);source=workspace/'document.pdf'
            with fitz.open() as doc:
                for _ in range(101): doc.new_page(width=72,height=72).insert_text((8,20),'ABC')
                doc.save(source)
            count=0
            for path in document_pages(source,workspace,pdf=True):
                self.assertTrue(path.read_bytes().startswith(b'\x89PNG'))
                self.assertEqual(list(workspace.glob('*.png')),[path]);count+=1
            self.assertEqual(count,101)
            self.assertEqual(list(workspace.glob('*.png')),[])

    def test_engine_sends_only_one_page_per_model_call(self):
        for filename in ['managed_dflash_engine.py','managed_dflash_office_engine.py']:
            spec=importlib.util.spec_from_file_location('page_engine',ROOT/'services/ocr-worker'/filename)
            engine=importlib.util.module_from_spec(spec);spec.loader.exec_module(engine)
            engine.RUNTIME=types.SimpleNamespace(inference_mode='vllm-dflash',backend_version='synthetic')
            calls=[]
            def render(source,workspace,**_):
                for i in range(101): yield workspace/str(i)
            def generate(batch):
                self.assertEqual(len(batch),1);calls.append(batch[0][0].name)
                return [('page '+str(len(calls)),engine.RUNTIME)]
            runtime=types.SimpleNamespace(generate_markdown_batch=generate)
            modules={'worker_hunyuanocr':types.ModuleType('worker_hunyuanocr'),'worker_hunyuanocr.ocr_runtime':runtime}
            with patch.dict(sys.modules,modules),patch.object(engine,'document_pages',render),patch.object(engine,'request_budget',return_value=1024),patch.object(engine,'input_budget',return_value=1024):
                result=engine.recognize({'model':engine.SERVED_MODEL,'job_id':'11111111-1111-4111-8111-111111111111','fileType':0,'file':'JVBERg=='})
            self.assertEqual(result['x_teamaibox']['page_count'],101)
            self.assertEqual(calls,[str(i) for i in range(101)])

if __name__=='__main__':unittest.main()

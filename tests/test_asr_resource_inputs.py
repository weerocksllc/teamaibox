"""Run inside the real ASR image; import dependencies but never load a model."""
import asyncio,importlib.util,json,sys,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0,'/opt/teamaibox')
if not Path('/opt/teamaibox/server.py').is_file():
    raise unittest.SkipTest('ASR image integration test: tools/build_asr_resource_runtime.py runs this against the real image')
spec=importlib.util.spec_from_file_location('asr_resource_worker','/opt/teamaibox/server.py')
worker=importlib.util.module_from_spec(spec);spec.loader.exec_module(worker)

class Upload:
    filename='long.wav'
    def __init__(self,size):self.left=size;self.closed=False
    async def read(self,size):
        count=min(size,self.left);self.left-=count;return b'\0'*count
    async def close(self):self.closed=True

class ASRResources(unittest.TestCase):
    def test_upload_larger_than_old_64_mib_quota(self):
        upload=Upload(65*1024*1024)
        with patch.object(worker,'MAX_UPLOAD_BYTES',None):
            path=asyncio.run(worker.store(upload))
        try:self.assertEqual(path.stat().st_size,65*1024*1024);self.assertTrue(upload.closed)
        finally:path.unlink()

    def test_explicit_administrator_quota_and_real_storage_failure_remain(self):
        with patch.object(worker,'MAX_UPLOAD_BYTES',1024),self.assertRaises(worker.HTTPException) as error:
            asyncio.run(worker.store(Upload(2048)))
        self.assertEqual(error.exception.status_code,413)
        with patch.object(worker,'MAX_UPLOAD_BYTES',None),patch.object(worker,'available_memory',return_value=0),self.assertRaises(worker.HTTPException) as error:
            asyncio.run(worker.store(Upload(2048)))
        self.assertEqual(error.exception.status_code,503)

    def test_more_than_ten_thousand_segments(self):
        class Model:
            def transcribe(self,*args,**kwargs):
                return (SimpleNamespace(start=i/10000,end=(i+1)/10000,text='x') for i in range(10001)),SimpleNamespace(language='en',duration=2)
        with patch.object(worker,'model',Model()),patch.object(worker,'probe_media',return_value=SimpleNamespace(duration_seconds=2)),patch.object(worker,'available_memory',return_value=512*1024*1024):
            result=worker.run_transcription(Path('fixture.wav'),None)
        self.assertEqual(len(result['segments']),10001)

    def test_full_file_decode_memory_checked_even_for_short_clip(self):
        with patch.object(worker,'model',object()),patch.object(worker,'probe_media',return_value=SimpleNamespace(duration_seconds=100000)),patch.object(worker,'available_memory',return_value=1024),self.assertRaises(worker.HTTPException) as error:
            worker.run_transcription(Path('fixture.wav'),None,(0,1))
        self.assertEqual(error.exception.status_code,503)

if __name__=='__main__':unittest.main()

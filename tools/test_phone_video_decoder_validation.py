"""A local codec pass must not be inflated into an Android/product pass."""
import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parent))
import qualify_phone_video_decoder as decoder


class DecoderEvidence(unittest.TestCase):
    def setUp(self):
        self.record=json.loads((decoder.E/'phone-video-decoder-20260914-a1.json').read_bytes())

    def test_exact_positive(self):decoder.verify(self.record)

    def test_rejects_scope_and_resource_overclaims(self):
        changes=[lambda r:r.update(androidTested=True),lambda r:r.update(productEnabled=True),
            lambda r:r['tests'].update(skipped=1),lambda r:r['tests'].update(errors=1),
            lambda r:r['tests'].update(count=18),lambda r:r['tests'].update(memorySwapBytes=4096),
            lambda r:r['tests'].update(memoryPeakBytes=513*1024**2),
            lambda r:r['container']['HostConfig'].update(MemorySwap=1024**3),
            lambda r:r['container']['HostConfig'].update(NetworkMode='host'),
            lambda r:r['container']['HostConfig'].update(Privileged=True),
            lambda r:r['container']['Mounts'][0].update(RW=True),
            lambda r:r['exit'].update(OOMKilled=True),lambda r:r.update(containerRemoved=False)]
        for change in changes:
            with self.subTest(change=change):
                value=copy.deepcopy(self.record);change(value)
                with self.assertRaises(RuntimeError):decoder.verify(value)


if __name__=='__main__':unittest.main()

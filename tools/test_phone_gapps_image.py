import hashlib
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

SOURCE=Path(__file__).resolve().parents[1]/'deploy/android/cuttlefish/gapps_image.py'
spec=importlib.util.spec_from_file_location('gapps_image',SOURCE);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)

def fixture(path):
    geometry=bytearray(struct.pack('<II32sIII',0x616c4467,52,bytes(32),65536,3,4096))
    geometry[8:40]=hashlib.sha256(geometry).digest()
    tables=(struct.pack('<36sIIII',b'product_a',1,0,1,0)+struct.pack('<QIQI',8,0,2048,0)
            +struct.pack('<36sIQ',b'default',0,0)+bytes(64))
    header=bytearray(128);struct.pack_into('<IHHI',header,0,0x414c5030,10,0,128)
    struct.pack_into('<I',header,44,len(tables));header[48:80]=hashlib.sha256(tables).digest()
    for pos,offset,count,step in [(80,0,1,52),(92,52,1,24),(104,76,1,48),(116,124,1,64)]:
        struct.pack_into('<III',header,pos,offset,count,step)
    header[12:44]=hashlib.sha256(header).digest()
    with path.open('wb') as f:
        f.truncate(2*1024**2)
        for off in (4096,8192):f.seek(off);f.write(geometry)
        f.seek(12288);f.write(header+tables);f.seek(1024**2+1024);f.write(bytes.fromhex('e2e1f5e0'))

class GappsImageTests(unittest.TestCase):
    def test_read_and_extract_never_mutate_source(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);image=root/'super.img';fixture(image);before=hashlib.sha256(image.read_bytes()).digest()
            result=module.extract(image,root,['product_a'])
            self.assertEqual(result['partitions'][0]['filesystem'],'erofs')
            self.assertEqual((root/'product_a.img').stat().st_size,4096)
            self.assertEqual(hashlib.sha256(image.read_bytes()).digest(),before)
            with self.assertRaises(FileExistsError):module.extract(image,root,['product_a'])

    def test_corrupt_metadata_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            image=Path(d)/'super.img';fixture(image)
            with image.open('r+b') as f:f.seek(12288+130);f.write(b'Z')
            with self.assertRaisesRegex(ValueError,'table_checksum'):module.read_layout(image)

    def test_wrong_format_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            image=Path(d)/'super.img';image.write_bytes(bytes(8192))
            with self.assertRaisesRegex(ValueError,'raw_geometry'):module.read_layout(image)

    def test_unknown_partition_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            image=Path(d)/'super.img';fixture(image)
            with self.assertRaisesRegex(ValueError,'partition_not_found'):module.extract(image,Path(d),['../userdata'])

if __name__=='__main__':unittest.main()

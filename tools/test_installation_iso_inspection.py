import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('inspect_iso', Path(__file__).resolve().parents[1]/'deploy/windows-computer/inspect_iso.py')
iso = importlib.util.module_from_spec(spec)
spec.loader.exec_module(iso)


def record(name, sector, size, directory=True):
    length = 33+len(name)+(0 if len(name)%2 else 1)
    value = bytearray(length)
    value[0] = length
    struct.pack_into('<I', value, 2, sector)
    struct.pack_into('>I', value, 6, sector)
    struct.pack_into('<I', value, 10, size)
    struct.pack_into('>I', value, 14, size)
    value[25] = 2 if directory else 0
    value[32] = len(name)
    value[33:33+len(name)] = name
    return value


def fixture(machine=0xaa64, filename=b'BOOTAA64.EFI;1'):
    value = bytearray(90*2048)
    pvd = bytearray(2048)
    pvd[:7] = b'\x01CD001\x01'
    struct.pack_into('<I', pvd, 80, 90)
    struct.pack_into('<H', pvd, 128, 2048)
    root = record(b'\0', 20, 2048)
    pvd[156:156+len(root)] = root
    value[16*2048:17*2048] = pvd
    for sector, entry in [(20, record(b'EFI',21,2048)),(21,record(b'BOOT',22,2048)),
                          (22,record(filename,23,128,False))]:
        value[sector*2048:sector*2048+len(entry)] = entry
    value[23*2048:23*2048+2] = b'MZ'
    struct.pack_into('<I',value,23*2048+60,64)
    value[23*2048+64:23*2048+68] = b'PE\0\0'
    struct.pack_into('<H',value,23*2048+68,machine)
    return value


class IsoInspectionTests(unittest.TestCase):
    def inspect(self, content, sparse_size=None):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'not-trusted-by-name.iso'
            path.write_bytes(content)
            if sparse_size:
                with path.open('r+b') as stream:
                    stream.truncate(sparse_size)
            return iso.inspect_iso(path)

    def test_pe_architecture_not_extension_or_name(self):
        self.assertEqual(self.inspect(fixture())['compatibility'],'arm64')
        self.assertEqual(self.inspect(fixture(0x8664))['compatibility'],'wrong-architecture')
        self.assertEqual(self.inspect(fixture(0x8664,b'BOOTX64.EFI;1'))['compatibility'],'wrong-architecture')
        self.assertEqual(self.inspect(fixture(0))['compatibility'],'unverified')

    def test_unknown_udf_is_unverified_not_rejected(self):
        content=bytearray(32*2048)
        content[17*2048+1:17*2048+6]=b'NSR03'
        result=self.inspect(content)
        self.assertEqual(result['compatibility'],'unverified')
        self.assertEqual(result['format'],'udf')

    def test_corrupt_size_and_non_iso_are_rejected(self):
        self.assertEqual(self.inspect(b'not an ISO')['compatibility'],'invalid')
        content=fixture()
        struct.pack_into('<I',content,16*2048+80,1000)
        self.assertEqual(self.inspect(content)['compatibility'],'invalid')

    def test_metadata_budget_is_not_an_iso_size_cap(self):
        result=self.inspect(fixture(),sparse_size=20*1024**3)
        self.assertEqual(result['compatibility'],'arm64')
        self.assertEqual(result['sizeBytes'],20*1024**3)
        self.assertLess(result['metadataBytesRead'],iso.METADATA_BUDGET)
        content=fixture()
        struct.pack_into('<I',content,16*2048+156+10,8*1024**2)
        struct.pack_into('>I',content,16*2048+156+14,8*1024**2)
        result=self.inspect(content,sparse_size=20*1024**3)
        self.assertEqual(result['compatibility'],'unverified')
        self.assertEqual(result['reason'],'inspection_budget')


if __name__ == '__main__':
    unittest.main()

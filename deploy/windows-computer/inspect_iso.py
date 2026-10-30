"""Bounded, read-only ISO/UEFI inspection; never mounts or executes an image.

Inspection is a compatibility hint, not a claim that an OS/driver set works.
UDF-only and complex/custom boot layouts remain explicitly unverified. The
parser's metadata budget limits work, not the size of an installation ISO.
"""
import argparse
import json
import os
import stat
import struct

SECTOR = 2048
METADATA_BUDGET = 4 * 1024 * 1024


class InvalidImage(Exception):
    pass


class InspectionBudget(Exception):
    pass


class Image:
    def __init__(self, fd, size):
        self.fd, self.size, self.read_bytes = fd, size, 0

    def read(self, offset, count):
        if offset < 0 or count < 0 or offset + count > self.size:
            raise InvalidImage()
        if self.read_bytes + count > METADATA_BUDGET:
            raise InspectionBudget()
        self.read_bytes += count
        value = os.pread(self.fd, count, offset)
        if len(value) != count:
            raise InvalidImage()
        return value

    def record(self, value):
        if len(value) < 34 or value[0] != len(value) or 33+value[32] > len(value):
            raise InvalidImage()
        extent = struct.unpack_from('<I', value, 2)[0]
        length = struct.unpack_from('<I', value, 10)[0]
        if extent != struct.unpack_from('>I', value, 6)[0] or length != struct.unpack_from('>I', value, 14)[0]:
            raise InvalidImage()
        if extent*SECTOR + length > self.size:
            raise InvalidImage()
        return {'offset': extent*SECTOR, 'size': length, 'directory': bool(value[25] & 2),
                'name': value[33:33+value[32]].split(b';')[0].upper()}

    def children(self, directory):
        if not directory['directory']:
            raise InvalidImage()
        contents = self.read(directory['offset'], directory['size'])
        entries = []
        offset = 0
        while offset < len(contents):
            length = contents[offset]
            if not length:
                offset = (offset//SECTOR + 1)*SECTOR
                continue
            if offset+length > len(contents) or offset//SECTOR != (offset+length-1)//SECTOR:
                raise InvalidImage()
            record = self.record(contents[offset:offset+length])
            if record['name'] not in (b'\0', b'\1'):
                entries.append(record)
            offset += length
        return entries

    def pe_architecture(self, entry):
        if entry['directory'] or entry['size'] < 64:
            return None
        header = self.read(entry['offset'], 64)
        if header[:2] != b'MZ':
            return None
        pe = struct.unpack_from('<I', header, 60)[0]
        if pe+6 > entry['size']:
            raise InvalidImage()
        signature = self.read(entry['offset']+pe, 6)
        if signature[:4] != b'PE\0\0':
            return None
        return {0xaa64: 'aarch64', 0x8664: 'x86_64', 0x14c: 'x86'}.get(struct.unpack_from('<H', signature, 4)[0])

    def inspect(self):
        root = None
        udf = False
        el_torito = False
        for sector in range(16, min(self.size//SECTOR, 80)):
            descriptor = self.read(sector*SECTOR, SECTOR)
            if descriptor[1:6] in (b'NSR02', b'NSR03'):
                udf = True
            if descriptor[1:6] != b'CD001':
                continue
            if descriptor[6] != 1:
                raise InvalidImage()
            if descriptor[0] == 0 and descriptor[7:39].rstrip(b'\0 ') == b'EL TORITO SPECIFICATION':
                el_torito = True
            if descriptor[0] == 1:
                if struct.unpack_from('<H', descriptor, 128)[0] != SECTOR:
                    return {'compatibility': 'unverified', 'format': 'iso9660', 'architectures': []}
                sectors = struct.unpack_from('<I', descriptor, 80)[0]
                if sectors*SECTOR > self.size or sectors < 17:
                    raise InvalidImage()
                root = self.record(descriptor[156:156+descriptor[156]])
        if root is None:
            return {'compatibility': 'unverified' if udf else 'invalid',
                    'format': 'udf' if udf else None, 'architectures': []}
        directories = self.children(root)
        efi = next((entry for entry in directories if entry['name'] == b'EFI' and entry['directory']), None)
        boot = next((entry for entry in self.children(efi) if entry['name'] == b'BOOT' and entry['directory']), None) if efi else None
        entries = self.children(boot) if boot else []
        architectures = set()
        for entry in entries:
            if entry['name'] in (b'BOOTAA64.EFI', b'BOOTX64.EFI', b'BOOTIA32.EFI'):
                architecture = self.pe_architecture(entry)
                if architecture:
                    architectures.add(architecture)
        # A PE machine type is stronger evidence than a suggestive filename.
        # Only a correctly named ARM64 fallback loader qualifies for this hint.
        arm = any(entry['name'] == b'BOOTAA64.EFI' and self.pe_architecture(entry) == 'aarch64' for entry in entries)
        compatibility = 'arm64' if arm else 'wrong-architecture' if architectures and 'aarch64' not in architectures else 'unverified'
        if not entries and not el_torito and not udf:
            compatibility = 'not-bootable'
        return {'compatibility': compatibility, 'format': 'iso9660', 'architectures': sorted(architectures)}


def inspect_iso(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('computer_media_invalid')
        image = Image(fd, info.st_size)
        try:
            result = image.inspect()
        except InvalidImage:
            result = {'compatibility': 'invalid', 'format': None, 'architectures': []}
        except InspectionBudget:
            result = {'compatibility': 'unverified', 'format': None, 'architectures': [], 'reason': 'inspection_budget'}
        return {**result, 'sizeBytes': info.st_size, 'metadataBytesRead': image.read_bytes}
    finally:
        os.close(fd)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('path')
    args = parser.parse_args()
    print(json.dumps(inspect_iso(args.path)))

#!/usr/bin/env python3
"""Read/extract this Cuttlefish raw super image without mounting host devices.

Layout: AOSP fs_mgr/liblp/include/liblp/metadata_format.h (Apache-2.0).
The writer remains upstream lpadd; this reader only accepts bounded, single-
device, linear extents and verifies geometry/header/table SHA-256 checksums.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct


def require(value, reason):
    if not value: raise ValueError(reason)


def checked(data, offset):
    expected=data[offset:offset+32]
    require(hashlib.sha256(data[:offset]+bytes(32)+data[offset+32:]).digest()==expected,'metadata_checksum')


def read_layout(path):
    size=path.stat().st_size
    with path.open('rb') as f:
        f.seek(4096); geometry=f.read(52)
        require(struct.unpack_from('<II',geometry)==(0x616c4467,52),'raw_geometry_required')
        checked(geometry,8)
        max_size,slots,block_size=struct.unpack_from('<III',geometry,40)
        require(128<=max_size<=1048576 and slots in (1,2,3) and block_size==4096,'geometry_limits')
        f.seek(8192);require(f.read(52)==geometry,'geometry_backup_mismatch')
        f.seek(12288);base=f.read(128)
        magic,major,minor,header_size=struct.unpack_from('<IHHI',base)
        require(magic==0x414c5030 and major==10 and minor<=2 and header_size in (128,256),'header_version')
        f.seek(12288);header=f.read(header_size);checked(header,12)
        table_size=struct.unpack_from('<I',header,44)[0]
        require(table_size<=max_size-header_size,'table_size')
        tables=f.read(table_size);require(hashlib.sha256(tables).digest()==header[48:80],'table_checksum')
        def table(offset,entry_size):
            start,count,step=struct.unpack_from('<III',header,offset)
            require(step==entry_size and start+count*step<=len(tables),'table_bounds')
            return [tables[start+i*step:start+(i+1)*step] for i in range(count)]
        devices=table(116,64);require(len(devices)==1,'multiple_devices_unsupported')
        groups=[struct.unpack('<36sIQ',x) for x in table(104,48)]
        extents=[struct.unpack('<QIQI',x) for x in table(92,24)]
        result=[]
        names=set()
        for raw in table(80,52):
            name,attributes,first,count,group=struct.unpack('<36sIIII',raw)
            name=name.rstrip(b'\0').decode('ascii')
            require(re.fullmatch(r'[a-zA-Z0-9_]+',name) and name not in names,'partition_name');names.add(name)
            require(first+count<=len(extents) and group<len(groups),'partition_bounds')
            selected=extents[first:first+count];segments=[]
            for sectors,kind,start,source in selected:
                require(kind==0 and source==0 and start*512>=12288+2*slots*max_size and (start+sectors)*512<=size,'extent_bounds')
                segments.append({'offset':start*512,'size':sectors*512})
            filesystem=None
            if segments:
                f.seek(segments[0]['offset']+1024);sb=f.read(60)
                filesystem='erofs' if sb[:4]==bytes.fromhex('e2e1f5e0') else 'ext4' if sb[56:58]==b'\x53\xef' else 'unknown'
            result.append(dict(name=name,attributes=attributes,group=groups[group][0].rstrip(b'\0').decode(),
                               size=sum(x['size'] for x in segments),segments=segments,filesystem=filesystem))
        return dict(size=size,metadataMaxSize=max_size,slots=slots,partitions=result)


def extract(path, folder, names):
    layout=read_layout(path);require(folder.is_dir() and not folder.is_symlink(),'output_directory')
    chosen=[p for p in layout['partitions'] if p['name'] in names]
    require(len(chosen)==len(set(names)),'partition_not_found')
    with path.open('rb') as source:
        for p in chosen:
            destination=folder/(p['name']+'.img')
            with destination.open('xb') as output:
                digest=hashlib.sha256()
                for part in p['segments']:
                    source.seek(part['offset']);remaining=part['size']
                    while remaining:
                        data=source.read(min(remaining,1024*1024));require(data,'truncated_image')
                        output.write(data);digest.update(data);remaining-=len(data)
                p['sha256']=digest.hexdigest()
    return layout


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--image',type=Path,required=True)
    parser.add_argument('--extract',type=Path);parser.add_argument('--partitions',nargs='+')
    args=parser.parse_args()
    result=extract(args.image,args.extract,args.partitions) if args.extract else read_layout(args.image)
    print(json.dumps(result,indent=2))

#!/usr/bin/env python3
"""Isolated real LUKS2/ext4 online grow, using synthetic files only."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

spec=importlib.util.spec_from_file_location('growth',sys.argv[1])
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
assert os.geteuid()==0
root=Path(tempfile.mkdtemp(prefix='teamaibox-growth-test-',dir='/var/lib')).resolve()
file=root/'synthetic.luks2';mount=root/'mounted';mount.mkdir(mode=0o700)
mapper=root.name;key=os.memfd_create('synthetic-growth-key',os.MFD_CLOEXEC)
os.write(key,os.getrandom(64))
mapped=mounted=False
result=dict(status='failed',failure=None,syntheticOnly=True)
try:
    fd=os.open(file,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    os.posix_fallocate(fd,0,128*1024**2);os.close(fd)
    def crypt(args):
        os.lseek(key,0,os.SEEK_SET)
        return g.command(['cryptsetup',*args,'--key-file',f'/proc/self/fd/{key}'],pass_fds=(key,))
    crypt(['luksFormat','--batch-mode','--type','luks2','--pbkdf','pbkdf2','--pbkdf-force-iterations','1000',str(file)])
    crypt(['open',str(file),mapper]);mapped=True
    g.command(['mkfs.ext4','-m','0','-O','project,quota','-E','quotatype=prjquota,nodiscard','/dev/mapper/'+mapper])
    g.command(['mount','-o','nosuid,nodev,noexec,prjquota','/dev/mapper/'+mapper,str(mount)]);mounted=True
    content=b'synthetic-persistent-data-20260914'*128
    (mount/'retained').write_bytes(content)
    inode=(mount/'retained').stat().st_ino
    uuid=g.command(['cryptsetup','luksUUID',str(file)])
    fsid=g.command(['blkid','-s','UUID','-o','value','/dev/mapper/'+mapper])
    before=os.statvfs(mount).f_blocks*os.statvfs(mount).f_frsize
    status=g.command(['cryptsetup','status',mapper])
    import re
    loop=re.search(r'^\s*device:\s+(/dev/loop[0-9]+)\s*$',status,re.M)[1]
    g.grow_mapping(file,mapper,loop,256*1024**2,key)
    after=os.statvfs(mount).f_blocks*os.statvfs(mount).f_frsize
    result.update(beforeBytes=before,afterBytes=after)
    # LUKS consumes 16 MiB; ext4 metadata also does not count as file space.
    assert before<128*1024**2 and after>220*1024**2
    assert (mount/'retained').read_bytes()==content and (mount/'retained').stat().st_ino==inode
    assert g.command(['cryptsetup','luksUUID',str(file)])==uuid
    assert g.command(['blkid','-s','UUID','-o','value','/dev/mapper/'+mapper])==fsid
    g.command(['repquota','-P','-n',str(mount)])
    # Allocate beyond the entire old filesystem, proving new extents writable.
    fd=os.open(mount/'new-extents',os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    os.posix_fallocate(fd,0,140*1024**2);os.fsync(fd);os.close(fd)
    (mount/'new-extents').unlink()
    # Same key and same filesystem survive a normal close/reopen of this fixture.
    g.command(['umount',str(mount)]);mounted=False
    g.command(['cryptsetup','close',mapper]);mapped=False
    crypt(['open',str(file),mapper]);mapped=True
    g.command(['mount','-o','nosuid,nodev,noexec,prjquota','/dev/mapper/'+mapper,str(mount)]);mounted=True
    assert (mount/'retained').read_bytes()==content
    (mount/'retained').unlink()
    result.update(status='passed',beforeBytes=before,afterBytes=after,onlineDataRetained=True,
                  originalKeyReopen=True,filesystemIdentityRetained=True,newExtentsWritable=True,quotaActive=True)
except Exception as e:
    result['failure']=str(e) if isinstance(e,g.original.PoolError) else type(e).__name__
finally:
    os.close(key)
    if mounted:g.command(['umount',str(mount)])
    if mapped:g.command(['cryptsetup','close',mapper])
    assert not g.command(['losetup','-j',str(file)])
    file.unlink();mount.rmdir();root.rmdir()
    result['fixtureRemoved']=True
print(json.dumps(result));sys.exit(0 if result['status']=='passed' else 1)

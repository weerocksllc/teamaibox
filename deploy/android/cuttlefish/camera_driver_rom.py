#!/usr/bin/env python3
"""Replace only virtio-media in an account-free vendor_dlkm successor."""
import hashlib,json,os,re,shutil
from pathlib import Path
from gapps_image import extract,read_layout,require
from gapps_inspect import sha,command
from gapps_assemble import partition_sha
from camera_preview_rom import tree

def main():
    base=Path(os.environ.get('PHONE_ROM_BASE','/base'));work=Path('/work');inputs=Path('/inputs');tools=Path('/opt/cuttlefish')
    os.environ['PATH']=str(tools/'bin')+':'+os.environ['PATH']
    parts=work/'partitions';parts.mkdir();old=extract(base/'super.img',parts,['vendor_dlkm_a'])
    vendor=work/'vendor_dlkm';command(['fsck.erofs','--extract='+str(vendor),'--preserve',parts/'vendor_dlkm_a.img'])
    before=tree(vendor);module=vendor/'lib/modules/virtio-media.ko';candidate=inputs/'virtio-media.ko'
    require(module.is_file() and not module.is_symlink(),'driver_missing')
    lock=json.loads((inputs/'driver.json').read_bytes())
    require(sha(candidate)==lock['moduleSha256'],'driver_changed')
    old_release=re.search(rb'vermagic=([^\x00]+)',module.read_bytes()).group(1)
    require(re.search(rb'vermagic=([^\x00]+)',candidate.read_bytes()).group(1)==old_release,'kernel_mismatch')
    shutil.copyfile(candidate,module)
    after=tree(vendor);changed=sorted(k for k in set(before)|set(after) if before.get(k)!=after.get(k))
    require(changed==['lib/modules/virtio-media.ko'],'unrelated_driver_file_changed')
    contexts=work/'file_contexts'
    contexts.write_text('\n'.join((inputs/p).read_text() for p in json.loads((inputs/'contexts.json').read_bytes())))
    images=work/'images';images.mkdir();image=images/'vendor_dlkm.img';avb=tools/'bin/avbtool';key=tools/'etc/cvd_avb_testkey_rsa4096.pem'
    command([avb,'extract_public_key','--key',key,'--output',work/'public.key'])
    info=command([avb,'info_image','--image',base/'vbmeta_vendor_dlkm.img'])
    require(hashlib.sha1((work/'public.key').read_bytes()).hexdigest() in info,'signing_key_changed')
    require(re.search(r'Flags:\s+0\b',info),'base_avb_disabled')
    command(['mkfs.erofs','--quiet','--workers=1','-b4096','-zlz4hc','-T1780617600',
        '--mount-point=/vendor_dlkm','--file-contexts='+str(contexts),image,vendor],timeout=300)
    # Grow only this small system partition if debug info requires it. No user
    # data partition, account state or existing phone volume is opened.
    partition=next(p for p in old['partitions'] if p['name']=='vendor_dlkm_a')
    size=max(partition['size'],((image.stat().st_size+1024**2+4095)//4096)*4096)
    command([avb,'add_hashtree_footer','--image',image,'--partition_name','vendor_dlkm','--partition_size',str(size),
        '--algorithm','SHA256_RSA4096','--key',key,'--hash_algorithm','sha256',
        '--salt','638b0acd6cc97403960ec9ad6cafb5f7616937807e042040fc0f6c0f48ca8c7d'],timeout=300)
    command([avb,'verify_image','--image',image,'--key',key],timeout=300)
    rollback=re.search(r'Rollback Index:\s+(\d+)',info).group(1);vbmeta=images/'vbmeta_vendor_dlkm.img'
    command([avb,'make_vbmeta_image','--output',vbmeta,'--algorithm','SHA256_RSA4096','--key',key,
        '--rollback_index',rollback,'--flags','0','--padding_size','4096',
        '--include_descriptors_from_image',base/'vbmeta_vendor_dlkm.img','--include_descriptors_from_image',image])
    verification=command([avb,'verify_image','--image',vbmeta,'--key',key],timeout=300)
    command(['cp','--reflink=auto','--sparse=always',base/'super.img',images/'super.img'],timeout=300)
    os.chmod(images/'super.img',0o600)
    command([tools/'bin/lpadd','--replace','--readonly',images/'super.img','vendor_dlkm_a',partition['group'],image],timeout=300)
    new={p['name']:p for p in read_layout(images/'super.img')['partitions']};unchanged={}
    require(set(new)=={p['name'] for p in old['partitions']},'partition_set_changed')
    for p in old['partitions']:
        expected=sha(image) if p['name']=='vendor_dlkm_a' else partition_sha(base/'super.img',p)
        require(partition_sha(images/'super.img',new[p['name']])==expected,'partition_bytes_changed')
        if p['name']!='vendor_dlkm_a':unchanged[p['name']]=expected
    for p in (images/'super.img',vbmeta):os.chmod(p,0o444)
    result=dict(status='passed',changedFiles=changed,moduleSha256=sha(module),unchangedFiles=len(after)-1,
        unchangedPartitions=unchanged,avbDisabled=False,originalAvbKeyPreserved=True,privateDataUsed=False,
        vbmetaVerification=verification,outputs={p.name:sha(p) for p in (images/'super.img',vbmeta)})
    (work/'assembly.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))

if __name__=='__main__':main()

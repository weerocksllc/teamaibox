#!/usr/bin/env python3
"""Build a separate test system; keep APK/APEX signatures and AVB enabled."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
from gapps_image import read_layout, require
from gapps_inspect import sha, command

def partition_sha(path,partition):
    digest=hashlib.sha256()
    with path.open('rb') as f:
        for segment in partition['segments']:
            f.seek(segment['offset']);remaining=segment['size']
            while remaining:
                block=f.read(min(remaining,1024**2));require(block,'partition_truncated')
                digest.update(block);remaining-=len(block)
    return digest.hexdigest()

def main():
    src=Path('/source');work=Path('/work');base=Path('/opt/cuttlefish')
    os.environ['PATH']=str(base/'bin')+':'+os.environ['PATH']
    inspection=json.loads((src/'inspection.json').read_text())
    require(inspection['allSelectedComponentSignaturesVerified'],'input_not_verified')
    key=base/'etc/cvd_avb_testkey_rsa4096.pem';avb=base/'bin/avbtool'
    command([avb,'extract_public_key','--key',key,'--output',work/'base.avbpubkey'])
    require(hashlib.sha1((work/'base.avbpubkey').read_bytes()).hexdigest() in inspection['baseAvbInfo'],'different_base_signing_key')
    contexts=work/'file_contexts'
    contexts.write_text('\n'.join((src/p).read_text() for p in inspection['contexts']))
    selected=[x for x in inspection['components'] if x['selected'] and x['path'].startswith(('system/product/','system/system_ext/'))]
    for part in ('product','system_ext'):
        command(['fsck.erofs','--extract='+str(work/part),'--preserve',src/'partitions'/(part+'_a.img')])
    for entry in selected:
        source=src/'gapps'/entry['path'];require(sha(source)==entry['sha256'],'component_changed')
        target=work/entry['path'].removeprefix('system/')
        require(not target.is_symlink(),'overlay_symlink')
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(source,target);os.chmod(target,0o644)
        require(sha(target)==entry['sha256'],'component_copy_changed')
    # Exactly the AOSP setup app overridden by Google's SetupWizard, in this
    # newly extracted build tree. No user data or source partition is writable.
    provision=work/'system_ext/priv-app/Provision'
    require(provision.is_dir() and not provision.is_symlink(),'unexpected_provision_layout')
    shutil.rmtree(provision)
    images=work/'images';images.mkdir()
    records=[]
    for part in ('product','system_ext'):
        image=images/(part+'.img')
        command(['mkfs.erofs','--quiet','--workers=1','-b4096','-zlz4hc','-T1780617600',
                 '--mount-point=/'+part,'--file-contexts='+str(contexts),image,work/part],timeout=600)
        # AVB metadata is signed with the same public AOSP test key already
        # trusted by this userdebug Cuttlefish base, not a Google signing key.
        command([avb,'add_hashtree_footer','--image',image,'--partition_name',part,
                 '--partition_size',str((1024 if part=='product' else 512)*1024**2),'--algorithm','SHA256_RSA4096','--key',key,
                 '--hash_algorithm','sha256','--salt','638b0acd6cc97403960ec9ad6cafb5f7616937807e042040fc0f6c0f48ca8c7d'],timeout=300)
        verification=command([avb,'verify_image','--image',image,'--key',key],timeout=300)
        records.append(dict(partition=part,size=image.stat().st_size,sha256=sha(image),verification=verification))
    vbmeta=images/'vbmeta_system.img'
    command([avb,'make_vbmeta_image','--output',vbmeta,'--algorithm','SHA256_RSA4096','--key',key,
             '--rollback_index','1780617600','--flags','0','--padding_size','4096',
             '--include_descriptors_from_image',base/'vbmeta_system.img',
             '--include_descriptors_from_image',images/'product.img',
             '--include_descriptors_from_image',images/'system_ext.img'])
    # verify_image resolves partition descriptors beside vbmeta. The unchanged
    # system is a read-only source link; no copy or mutation is needed.
    (images/'system.img').symlink_to(src/'partitions/system_a.img')
    meta_verification=command([avb,'verify_image','--image',vbmeta,'--key',key],timeout=300)
    command(['cp','--reflink=auto','--sparse=always',base/'super.img',images/'super.img'],timeout=300)
    # cp preserves the read-only source mode. Only this new output is writable
    # while lpadd updates it; the original stays on the read-only image layer.
    os.chmod(images/'super.img',0o600)
    for part in ('product','system_ext'):
        command([base/'bin/lpadd','--replace','--readonly',images/'super.img',part+'_a',
                 'google_system_dynamic_partitions_a',images/(part+'.img')],timeout=300)
    old=read_layout(base/'super.img');new=read_layout(images/'super.img')
    previous={p['name']:p for p in old['partitions']};current={p['name']:p for p in new['partitions']}
    require(set(previous)==set(current),'partition_set_changed')
    unchanged={}
    for name,a in previous.items():
        b=current[name]
        # lpadd moves replaced entries to the end of the metadata table. Bind
        # by partition name, never table position; verify actual bytes too.
        if name not in ('product_a','system_ext_a'):
            require(a==b,'unrelated_partition_changed')
            expected=partition_sha(base/'super.img',a)
            require(expected==partition_sha(images/'super.img',b),'unrelated_partition_bytes_changed')
            unchanged[name]=expected
        else:require(partition_sha(images/'super.img',b)==sha(images/(name.removesuffix('_a')+'.img')),'inserted_partition_mismatch')
    os.chmod(images/'super.img',0o444);os.chmod(vbmeta,0o444)
    result=dict(baseSuperSha256=sha(base/'super.img'),
                selectedComponents=selected,excludedComponents=[x for x in inspection['components'] if not x['selected']],
                partitions=records,layout=new,unchangedPartitionSha256=unchanged,vbmetaVerification=meta_verification,avbDisabled=False,
                originalGoogleSignaturesPreserved=True,androidStarted=False,
                outputs={p.name:sha(p) for p in (images/'super.img',vbmeta)})
    (work/'assembly.json').write_text(json.dumps(result,indent=2))
    print(json.dumps({'outputs':result['outputs'],'avbDisabled':False,'selectedComponents':len(selected)}))

if __name__=='__main__':main()

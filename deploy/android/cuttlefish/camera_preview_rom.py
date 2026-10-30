#!/usr/bin/env python3
"""Replace only stock Camera2 in an account-free copy; keep AVB enabled."""
import hashlib,json,os,re,shutil,stat,zipfile
from pathlib import Path
from gapps_image import extract,read_layout,require
from gapps_inspect import sha,command
from gapps_assemble import partition_sha

def tree(root):
    result={}
    for p in root.rglob('*'):
        key=str(p.relative_to(root));info=p.lstat()
        if p.is_symlink():result[key]=dict(link=os.readlink(p),mode=stat.S_IMODE(info.st_mode))
        elif p.is_file():result[key]=dict(sha256=sha(p),mode=stat.S_IMODE(info.st_mode),uid=info.st_uid,gid=info.st_gid)
    return result

def main():
    base=Path('/opt/cuttlefish');work=Path('/work');inputs=Path('/inputs')
    os.environ['PATH']=str(base/'bin')+':'+os.environ['PATH']
    parts=work/'partitions';parts.mkdir();old=extract(base/'super.img',parts,['product_a','system_a','system_ext_a'])
    product=work/'product';command(['fsck.erofs','--extract='+str(product),'--preserve',parts/'product_a.img'])
    before=tree(product);apk=product/'app/Camera2/Camera2.apk';replacement=inputs/'Camera2.apk'
    require(sha(apk)=='5888fe9106b4cd2d47a52a65f209e9464f77793b4477ff036c3797fdf44191d1','stock_camera_changed')
    build=json.loads((inputs/'camera-preview.json').read_bytes())
    require(build.get('status')=='built' and build.get('stockSha256')==sha(apk)
        and build.get('apkSha256')==sha(replacement),'replacement_changed')
    cert='a40da80a59d170caa950cf15c18c454d47a39b26989d8b640ecd745ba71bf5dc'
    for file in (apk,replacement):
        verified=command(['apksigner','verify','--min-sdk-version','37','--max-sdk-version','37','--print-certs',file])
        require(cert in verified,'camera_signer_changed')
    with zipfile.ZipFile(apk) as a,zipfile.ZipFile(replacement) as b:
        require(a.read('AndroidManifest.xml')==b.read('AndroidManifest.xml') and a.read('resources.arsc')==b.read('resources.arsc'),'camera_permissions_or_resources_changed')
    shutil.copyfile(replacement,apk)
    removed=[]
    oat=product/'app/Camera2/oat'
    if oat.exists():
        require(not oat.is_symlink(),'unsafe_oat')
        for p in oat.rglob('*'):
            if p.is_file():
                require(not p.is_symlink() and p.suffix in ('.odex','.vdex','.art'),'unexpected_precompiled_file')
                removed.append(str(p.relative_to(product)));p.unlink()
        for p in sorted(oat.rglob('*'),key=lambda p:len(p.parts),reverse=True):
            require(p.is_dir() and not p.is_symlink(),'unexpected_oat_entry');p.rmdir()
        oat.rmdir()
    after=tree(product);changed=[k for k in set(before)|set(after) if before.get(k)!=after.get(k)]
    require(set(changed)=={'app/Camera2/Camera2.apk'}|set(removed),'unrelated_product_file_changed')
    contexts=work/'file_contexts';context_files=json.loads((inputs/'contexts.json').read_bytes())
    contexts.write_text('\n'.join((inputs/p).read_text() for p in context_files))
    images=work/'images';images.mkdir();image=images/'product.img';avb=base/'bin/avbtool';key=base/'etc/cvd_avb_testkey_rsa4096.pem'
    command(['mkfs.erofs','--quiet','--workers=1','-b4096','-zlz4hc','-T1780617600','--mount-point=/product','--file-contexts='+str(contexts),image,product],timeout=600)
    size=next(p['size'] for p in old['partitions'] if p['name']=='product_a')
    command([avb,'add_hashtree_footer','--image',image,'--partition_name','product','--partition_size',str(size),
        '--algorithm','SHA256_RSA4096','--key',key,'--hash_algorithm','sha256','--salt','638b0acd6cc97403960ec9ad6cafb5f7616937807e042040fc0f6c0f48ca8c7d'],timeout=300)
    command([avb,'verify_image','--image',image,'--key',key],timeout=300)
    info=command([avb,'info_image','--image',base/'vbmeta_system.img']);rollback=re.search(r'Rollback Index:\s+(\d+)',info).group(1)
    vbmeta=images/'vbmeta_system.img'
    command([avb,'make_vbmeta_image','--output',vbmeta,'--algorithm','SHA256_RSA4096','--key',key,'--rollback_index',rollback,'--flags','0','--padding_size','4096',
        '--include_descriptors_from_image',base/'vbmeta_system.img','--include_descriptors_from_image',image])
    for name in ('system','system_ext'):(images/(name+'.img')).symlink_to(parts/(name+'_a.img'))
    verification=command([avb,'verify_image','--image',vbmeta,'--key',key],timeout=300)
    command(['cp','--reflink=auto','--sparse=always',base/'super.img',images/'super.img'],timeout=300);os.chmod(images/'super.img',0o600)
    command([base/'bin/lpadd','--replace','--readonly',images/'super.img','product_a','google_system_dynamic_partitions_a',image],timeout=300)
    new={p['name']:p for p in read_layout(images/'super.img')['partitions']};unchanged={}
    require(set(new)=={p['name'] for p in old['partitions']},'partition_set_changed')
    for p in old['partitions']:
        if p['name']=='product_a':require(partition_sha(images/'super.img',new[p['name']])==sha(image),'product_insert_failed')
        else:
            digest=partition_sha(base/'super.img',p);require(partition_sha(images/'super.img',new[p['name']])==digest,'other_partition_changed')
            unchanged[p['name']]=digest
    os.chmod(images/'super.img',0o444);os.chmod(vbmeta,0o444)
    result=dict(status='passed',apkSha256=sha(replacement),originalSignerPreserved=True,permissionsAndResourcesUnchanged=True,
        changedProductFiles=sorted(changed),removedStalePrecompiled=sorted(removed),unchangedProductFiles=len(after)-1,
        unchangedPartitions=unchanged,avbDisabled=False,vbmetaVerification=verification,androidStarted=False,privateDataUsed=False,
        outputs={p.name:sha(p) for p in (images/'super.img',vbmeta)})
    (work/'assembly.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
if __name__=='__main__':main()

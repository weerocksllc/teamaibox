#!/usr/bin/env python3
"""Inspect public GApps and pristine partitions. Never execute the installer."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import zipfile
from gapps_image import extract, require

def sha(path):
    with path.open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()

def command(args,timeout=180):
    p=subprocess.run([str(x) for x in args],capture_output=True,timeout=timeout)
    require(p.returncode==0,Path(args[0]).name+':'+p.stderr.decode(errors='replace')[-1200:])
    return p.stdout.decode(errors='replace')

def apex_manifest(raw):
    # ApexManifest protobuf: field 1=name, field 2=version. Modern APEX files
    # need not carry the optional JSON rendering. Unknown fields are skipped.
    pos=0;result={}
    def varint():
        nonlocal pos
        value=0
        for shift in range(0,70,7):
            require(pos<len(raw),'truncated_apex_manifest');b=raw[pos];pos+=1;value|=(b&127)<<shift
            if not b&128:return value
        raise ValueError('oversize_varint')
    while pos<len(raw):
        tag=varint();field,kind=tag>>3,tag&7
        if kind==0:value=varint()
        elif kind==2:
            length=varint();require(pos+length<=len(raw),'protobuf_length');value=raw[pos:pos+length];pos+=length
        elif kind in (1,5):pos+=8 if kind==1 else 4;continue
        else:raise ValueError('unknown_protobuf_wire_type')
        if field==1:result['name']=value.decode('utf-8')
        if field==2:result['version']=value
    require(result.get('name')=='com.google.android.gmssystem' and isinstance(result.get('version'),int),'unexpected_apex')
    return result

def main():
    work=Path('/work');lock=json.loads(Path('/input/input.json').read_text());archive=Path('/input')/lock['asset']
    require(archive.stat().st_size==lock['size'] and sha(archive)==lock['sha256'],'archive_changed')
    partitions=work/'partitions';partitions.mkdir()
    layout=extract(Path('/opt/cuttlefish/super.img'),partitions,['product_a','system_ext_a','system_a'])
    for part in ('product','system_ext','system'):
        command(['fsck.erofs','--extract='+str(work/part),'--no-preserve-owner',str(partitions/(part+'_a.img'))])
    with zipfile.ZipFile(archive) as z:
        require(z.read('build.prop')==b'arch=arm64\nversion=37\nversion_nice=17.0.0\n','gapps_platform_mismatch')
        target=work/'gapps';target.mkdir()
        for info in z.infolist():
            p=Path(info.filename)
            require(not p.is_absolute() and '..' not in p.parts and not ((info.external_attr>>16)&0o170000)==0o120000,'unsafe_zip_entry')
            if not info.filename.startswith('system/'):continue
            require(info.file_size<512*1024**2,'oversize_component')
            z.extract(info,target)
    components=[]
    for p in sorted(target.rglob('*')):
        if not p.is_file():continue
        item=dict(path=str(p.relative_to(target)),size=p.stat().st_size,sha256=sha(p))
        item['selected']=item['path']!='system/product/priv-app/VelvetTitan/VelvetTitan.apk'
        if not item['selected']: item['exclusionReason']='Upstream installer selects VelvetTitan only for tangorpro, not Cuttlefish.'
        if p.suffix in ('.apk','.apex'):
            # Verify the original signed bytes, including the APEX APK envelope.
            args=['apksigner','verify','--min-sdk-version','37','--max-sdk-version','37','--verbose','--print-certs',str(p)]
            verified_result=subprocess.run(args,capture_output=True,text=True,timeout=180)
            verified=verified_result.stdout
            item['signatureVerified']=verified_result.returncode==0
            item['signatureTargetSdk']=37
            item['signers']=[line for line in verified.splitlines() if 'certificate SHA-256 digest:' in line]
            if not item['signatureVerified']:
                require(item['path']=='system/product/app/PrebuiltExchange3Google/PrebuiltExchange3Google.apk'
                    and item['sha256']=='3f65c5fb9da1e341590373497a520c18b286eb44946d0b1b6a8e588e6985acdb'
                    and 'Signature stripped?' in verified_result.stderr,'invalid_component_signature:'+item['path'])
                item.update(selected=False,exclusionReason='Optional Exchange mail adapter rejected: APK v2 anti-stripping verification failed.',
                            signatureError=verified_result.stderr.strip())
            else: require(item['signers'],'no_signer')
        components.append(item)
    apex=next(target.rglob('*.apex'))
    with zipfile.ZipFile(apex) as z:
        manifest=apex_manifest(z.read('apex_manifest.pb'))
        with (work/'gms-apex-payload.img').open('xb') as f:f.write(z.read('apex_payload.img'))
        (work/'gms-apex-key.avbpubkey').write_bytes(z.read('apex_pubkey'))
    avb=command(['/opt/cuttlefish/bin/avbtool','info_image','--image',work/'gms-apex-payload.img'])
    payload_verification=command(['/opt/cuttlefish/bin/avbtool','verify_image','--image',work/'gms-apex-payload.img'])
    require(hashlib.sha1((work/'gms-apex-key.avbpubkey').read_bytes()).hexdigest() in avb,'apex_payload_key_mismatch')
    payload_key_sha=sha(work/'gms-apex-key.avbpubkey')
    base_avb=command(['/opt/cuttlefish/bin/avbtool','info_image','--image','/opt/cuttlefish/vbmeta_system.img'])
    contexts=[str(x.relative_to(work)) for x in work.rglob('*file_contexts') if x.is_file()]
    properties={}
    for p in (work/'system/system/build.prop',work/'system/build.prop',work/'product/build.prop'):
        if p.is_file():
            for line in p.read_text().splitlines():
                if line.startswith(('ro.build.version.sdk=','ro.build.version.release=','ro.product.cpu.abilist=')):
                    key,value=line.split('=',1);properties[key]=value
    require(properties.get('ro.build.version.sdk')=='37','base_sdk_mismatch')
    result=dict(layout=layout,baseProperties=properties,components=components,apexManifest=manifest,
        apexPayloadKeySha256=payload_key_sha,apexAvbInfo=avb,apexPayloadVerification=payload_verification,baseAvbInfo=base_avb,contexts=contexts,
        allSelectedComponentSignaturesVerified=True,upstreamInstallerExecuted=False,androidStarted=False)
    (work/'inspection.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(dict(components=len(components),signaturesVerified=sum(x.get('signatureVerified',False) for x in components),
                         apex=manifest,baseProperties=properties,contexts=contexts)))

if __name__=='__main__':main()

#!/usr/bin/env python3
"""Build a compact copy of an image, never a running container filesystem.

Run on an explicitly authorized build host. Temporary containers are never started, have no
mounts or network, and are removed by exact ID. Compare complete image config
and all rootfs file content, ownership, modes, symlinks and extended attributes.
"""
import os
import argparse, hashlib, json, re, subprocess, tarfile
from pathlib import Path

PARENT=os.environ.get('TEAMAIBOX_FLATTEN_PHONE_PLATFORM_IMAGE_V2_PARENT')
IGNORED={'.dockerenv','etc/hosts','etc/hostname','etc/resolv.conf'}

def need(ok,code):
    if not ok: raise RuntimeError(code)

def command(args,timeout=120):
    result=subprocess.run(args,capture_output=True,timeout=timeout)
    if result.returncode: raise RuntimeError('image_command_failed')
    return result.stdout

def inspect(kind,target):return json.loads(command(['docker',kind,'inspect',target]))[0]
def digest(raw):return hashlib.sha256(raw).hexdigest()
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':')).encode()

def dockerfile(config,tag):
    need(not config.get('Volumes') and not config.get('OnBuild') and config.get('Cmd') is None,'unsupported_image_config')
    lines=['FROM '+tag+' AS original','FROM scratch','COPY --from=original / /']
    for value in config['Env']:
        name,content=value.split('=',1);need(re.fullmatch('[A-Z_][A-Z0-9_]*',name),'invalid_image_environment')
        lines.append('ENV '+name+'='+json.dumps(content))
    lines+=['USER '+config['User'],'WORKDIR '+config['WorkingDir'],'ENTRYPOINT '+json.dumps(config['Entrypoint'])]
    for port in config.get('ExposedPorts',{}):
        need(re.fullmatch('[0-9]+/(tcp|udp)',port),'invalid_exposed_port');lines.append('EXPOSE '+port)
    for key,value in (config.get('Labels') or {}).items():lines.append('LABEL '+json.dumps(key)+'='+json.dumps(value))
    return '\n'.join(lines)+'\n'

def filesystem(path):
    records={}
    with tarfile.open(path,'r:') as archive:
        for entry in archive:
            name=entry.name.removeprefix('./').rstrip('/')
            if name in IGNORED: continue
            need(name not in records and not name.startswith('/') and '..' not in name.split('/'),'invalid_rootfs_tar')
            row={'mode':entry.mode,'uid':entry.uid,'gid':entry.gid,
                 'xattrs':{k:v for k,v in entry.pax_headers.items() if 'xattr' in k}}
            if entry.isfile() or entry.islnk():
                h=hashlib.sha256();size=0
                with archive.extractfile(entry) as stream:
                    for block in iter(lambda:stream.read(1024*1024),b''):h.update(block);size+=len(block)
                row.update(type='file',size=size,sha256=h.hexdigest())
            elif entry.isdir(): row.update(type='directory')
            elif entry.issym(): row.update(type='symlink',target=entry.linkname)
            else: row.update(type=entry.type.decode(),major=entry.devmajor,minor=entry.devminor)
            records[name]=row
    return records

def main():
    if PARENT is None:
        raise ValueError('explicit_TEAMAIBOX_FLATTEN_PHONE_PLATFORM_IMAGE_V2_PARENT_required')
    parser=argparse.ArgumentParser();parser.add_argument('--run-id',required=True);a=parser.parse_args();rid=a.run_id
    need(re.fullmatch(r'phone-platform-flatten-\d{8}-a[1-9][0-9]*',rid),'invalid_run')
    root=Path('/var/tmp/teamaibox-'+rid);need(not root.exists(),'run_occupied')
    parent=inspect('image',PARENT);need(parent['Architecture']=='arm64' and len(parent['RootFS']['Layers'])==127,'parent_changed')
    root.mkdir(mode=0o700);tag='teamaibox/platform-api:'+rid
    command(['docker','tag',PARENT,tag+'-parent'])
    (root/'Dockerfile').write_text(dockerfile(parent['Config'],tag+'-parent'))
    result=dict(runId=rid,status='failed',parentImageId=PARENT,parentLayers=127,containersStarted=False,
                excludedDockerGeneratedFiles=sorted(IGNORED),stage=str(root));containers=[]
    try:
        build=subprocess.run(['docker','build','--network=none','--pull=false','--memory=1g','--memory-swap=1g','--cpu-period=100000','--cpu-quota=100000','-t',tag,str(root)],capture_output=True,timeout=180)
        result['buildExitCode']=build.returncode
        need(build.returncode==0,'flatten_build_failed')
        new=inspect('image',tag);need(new['Architecture']=='arm64' and len(new['RootFS']['Layers'])==2 and new['RootFS']['Layers'][1]=='sha256:5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef','not_flattened')
        need(parent['Config']==new['Config'],'image_configuration_changed')
        rows=[]
        for label,image in [('original',PARENT),('flattened',new['Id'])]:
            cid=command(['docker','create','--name',rid+'-'+label,'--network=none','--read-only','--memory=256m','--memory-swap=256m','--cpus=1','--entrypoint=/bin/false',image]).decode().strip()
            need(re.fullmatch('[a-f0-9]{64}',cid),'container_id_invalid');containers.append((cid,image))
            info=inspect('container',cid);need(info['State']['Status']=='created' and not info['Mounts'],'snapshot_container_changed')
            target=root/(label+'.tar');command(['docker','export','--output',str(target),cid],180)
            rows.append(filesystem(target))
        need(rows[0]==rows[1],'rootfs_changed')
        result.update(status='passed',imageId=new['Id'],tag=tag,finalLayers=2,emptyMetadataLayer=new['RootFS']['Layers'][1],configSha256=digest(canonical(new['Config'])),
                      rootfsSha256=digest(canonical(rows[0])),rootfsEntries=len(rows[0]),rootfsCompared=True,configurationMatched=True)
    except Exception as error:result['failure']=str(error) if isinstance(error,RuntimeError) else type(error).__name__
    finally:
        removed=[]
        for cid,image in containers:
            info=inspect('container',cid);need(info['Image']==image and info['State']['Status']=='created' and not info['Mounts'],'cleanup_identity_changed')
            command(['docker','rm',cid]);removed.append(cid)
        result['temporaryContainersRemoved']=removed
        with (root/'result.json').open('x') as out:json.dump(result,out,indent=2)
    print(json.dumps(result));return 0 if result['status']=='passed' else 1

if __name__=='__main__':raise SystemExit(main())

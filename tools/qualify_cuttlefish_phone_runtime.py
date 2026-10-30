#!/usr/bin/env python3
"""Bounded, synthetic phone qualification on the auxiliary host only.

Creates a NEW regular-file LUKS2 volume, never formats a physical disk. The key
exists only in this process and cryptsetup's stdin; closing the mapping makes
the retained ciphertext disposable. This does NOT register a production pool.
No LAN port, Docker socket, host network, GPU or old lab data enters the phone.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import subprocess
import time
import uuid

RUN = re.compile(r'^phone-runtime-\d{8}-a[1-9][0-9]{0,2}$')
IMAGE = re.compile(r'^sha256:[0-9a-f]{64}$')
BASE = Path(os.environ.get('TEAMAIBOX_PHONE_QUALIFICATION_ROOT', '/var/tmp/teamaibox-phone-qualification'))
SECCOMP = Path(os.environ.get('TEAMAIBOX_PHONE_SECCOMP_FILE', '/etc/teamaibox/phone-seccomp.json'))
SECCOMP_SHA = os.environ.get('TEAMAIBOX_PHONE_SECCOMP_SHA256')


def command(args, timeout=60, *, data=None, check=True):
    value=subprocess.run([str(x) for x in args], input=data, stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, timeout=timeout)
    if check and value.returncode:
        # Do not leak key material or arbitrary guest output in the host report.
        raise RuntimeError('command_failed:'+Path(args[0]).name+':'+str(value.returncode))
    return value


def output(args, timeout=60): return command(args,timeout).stdout.decode().strip()


def paths(run_id):
    if not RUN.fullmatch(run_id): raise ValueError('invalid_run_id')
    root=BASE/('teamaibox-'+run_id)
    return root, 'tab-phone-'+run_id.removeprefix('phone-runtime-')


def read_host():
    memory={line.split(':')[0]:int(line.split()[1])*1024 for line in Path('/proc/meminfo').read_text().splitlines()}
    pressure=Path('/proc/pressure/memory').read_text().splitlines()[0]
    psi=float(dict(item.split('=') for item in pressure.split()[1:])['avg10'])
    vm=dict(line.split() for line in Path('/proc/vmstat').read_text().splitlines())
    return dict(available=memory['MemAvailable'],psi=psi,swapout=int(vm['pswpout'])*os.sysconf('SC_PAGE_SIZE'))


def baseline():
    first=read_host(); minimum=first['available']; peak=first['psi']
    for _ in range(15):
        time.sleep(2); current=read_host()
        minimum=min(minimum,current['available']); peak=max(peak,current['psi'])
        if minimum < 22*1024**3 or peak >= 1 or current['swapout'] != first['swapout']:
            raise RuntimeError('phone_capacity_unavailable')
    return dict(durationSeconds=30,minAvailableBytes=minimum,maxMemoryPsiAvg10=peak,swapoutDeltaBytes=0)


def inventory():
    ids=output(['docker','ps','-q','--no-trunc']).splitlines()
    if not ids: return {}
    values=json.loads(output(['docker','inspect',*ids]))
    return {v['Id']:{'name':v['Name'],'image':v['Image'],'running':v['State']['Running']} for v in values}


def run(run_id, image_id, file_fixture):
    if not SECCOMP.is_absolute() or not re.fullmatch(r'[0-9a-f]{64}', SECCOMP_SHA or ''):
        raise ValueError('explicit_seccomp_file_and_sha256_required')
    if os.geteuid() != 0 or not IMAGE.fullmatch(image_id): raise ValueError('root_and_exact_image_required')
    if not file_fixture.is_file() or file_fixture.is_symlink() or file_fixture.stat().st_size>1024**2:
        raise ValueError('invalid_file_fixture')
    root,mapper=paths(run_id); mapped=Path('/dev/mapper')/mapper
    if root.exists() or root.is_symlink() or mapped.exists(): raise ValueError('run_already_used')
    if hashlib.sha256(SECCOMP.read_bytes()).hexdigest()!=SECCOMP_SHA: raise ValueError('seccomp_changed')
    identity=json.loads(output(['docker','image','inspect',image_id]))[0]
    if identity['Id']!=image_id or identity['Architecture']!='arm64': raise ValueError('wrong_runtime_image')
    if os.statvfs(BASE).f_bavail*os.statvfs(BASE).f_frsize < 40*1024**3: raise ValueError('insufficient_disk_space')
    before=inventory()
    for name in ('/dev/kvm','/dev/vhost-vsock'):
        if not stat.S_ISCHR(os.stat(name).st_mode): raise ValueError('device_missing')
    root.mkdir(mode=0o700)
    report=dict(runId=run_id,imageId=image_id,startedAtUnix=time.time(),passed=False,
                productionPoolRegistered=False,networkIsolationAccepted=False,cycles=[],cleanup={})
    report['sourceDigests']={'qualifier':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), 'seccomp':SECCOMP_SHA}
    report['image']={k:identity[k] for k in ('Id','Architecture')}
    report['image'].update(user=identity['Config']['User'],entrypoint=identity['Config']['Entrypoint'])
    mount=root/'mount'; mount.mkdir(mode=0o700)
    backing=root/'data.luks2'; descriptor=os.open(backing,os.O_CREAT|os.O_EXCL|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try: os.ftruncate(descriptor,16*1024**3); os.fsync(descriptor)
    finally: os.close(descriptor)
    backing_identity=(backing.stat().st_dev,backing.stat().st_ino)
    key=secrets.token_bytes(64); opened=False; mounted=False; containers=[]
    config={k:str(uuid.uuid5(uuid.NAMESPACE_URL,run_id+':'+k)) for k in ('phoneId','ownerId','volumeId')}
    config.update(version=1,buildId='16102939',instance=21)
    try:
        report['baseline']=baseline()
        command(['cryptsetup','luksFormat','--batch-mode','--type','luks2','--pbkdf','argon2id',
                 '--pbkdf-memory','65536','--pbkdf-parallel','1','--iter-time','1000','--key-file','-',backing],data=key)
        command(['cryptsetup','open','--type','luks2','--key-file','-',backing,mapper],data=key); opened=True
        metadata=json.loads(output(['cryptsetup','luksDump','--dump-json-metadata',backing]))
        if not metadata.get('segments') or not stat.S_ISBLK(mapped.stat().st_mode): raise RuntimeError('luks_not_ready')
        mapping=output(['cryptsetup','status',mapper])
        device=re.search(r'^\s*device:\s*(/dev/loop[0-9]+)\s*$',mapping,re.MULTILINE)
        if not device: raise RuntimeError('not_file_backed_mapping')
        loops=json.loads(output(['losetup','--json','--list','--output','NAME,BACK-FILE',device.group(1)]))['loopdevices']
        if len(loops)!=1 or loops[0]['back-file']!=str(backing): raise RuntimeError('mapping_identity_mismatch')
        command(['mkfs.ext4','-q','-F',mapped])
        command(['mount','-o','nodev,nosuid,noexec',mapped,mount]); mounted=True
        report['storage']={'luksVersion':2,'fileBacked':True,'privateVolumeBytes':16*1024**3,'physicalDiskFormatted':False}
        data=mount/'phone'; data.mkdir(mode=0o700); os.chown(data,10001,10001)
        control=mount/'control'; control.mkdir(mode=0o700); os.chown(control,10001,10001)
        certs=control/'certs'; certs.mkdir(mode=0o700); os.chown(certs,10001,10001)
        command(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','1',
                 '-subj','/CN=phone-runtime-loopback','-addext','subjectAltName=IP:127.0.0.1',
                 '-keyout',certs/'server.key','-out',certs/'server.crt'])
        for path in certs.iterdir(): os.chown(path,10001,10001); os.chmod(path,0o600)
        android_id=None
        for cycle in (1,2):
            declaration=config|{'generation':cycle,'runId':str(uuid.uuid5(uuid.NAMESPACE_URL,run_id+':run:'+str(cycle)))}
            declaration_path=control/('config-'+str(cycle)+'.json')
            declaration_path.write_text(json.dumps(declaration)); os.chown(declaration_path,10001,10001); os.chmod(declaration_path,0o400)
            name=mapper+'-cycle'+str(cycle)
            if command(['docker','inspect',name],check=False).returncode==0: raise RuntimeError('container_name_used')
            args=['docker','create','--name',name,'--label','teamaibox.phone-qualification='+run_id,
                  '--read-only','--user','10001:10001','--cap-drop','ALL','--security-opt','no-new-privileges',
                  '--group-add','1000','--group-add','1001',
                  '--security-opt','seccomp='+str(SECCOMP),'--network','none','--init',
                  '--memory','6442450944','--memory-swap','6442450944','--cpus','2','--pids-limit','1024',
                  '--ulimit','core=0','--ulimit','nofile=8192:8192','--stop-timeout','75',
                  '--log-driver','none','--tmpfs','/tmp:rw,nosuid,nodev,size=536870912,mode=1777',
                  '--mount','type=bind,src='+str(data)+',dst=/phone',
                  '--mount','type=bind,src='+str(declaration_path)+',dst=/run/phone/config.json,readonly',
                  '--mount','type=bind,src='+str(certs)+',dst=/run/phone/certs,readonly']
            args+=['--mount','type=bind,src='+str(file_fixture.resolve())+',dst=/run/phone-test.apk,readonly']
            for device_path in ('/dev/kvm','/dev/vhost-vsock'):
                args+=['--device',device_path+':'+device_path+':rw','--group-add',str(os.stat(device_path).st_gid)]
            container=output([*args,image_id]); containers.append(container)
            observed=json.loads(output(['docker','inspect',container]))[0]
            security={k:observed['HostConfig'][k] for k in ('Memory','MemorySwap','NanoCpus','ReadonlyRootfs','Privileged',
                      'CapDrop','CapAdd','GroupAdd','NetworkMode','PidMode','IpcMode','PortBindings','Devices','DeviceRequests','RestartPolicy')}
            output(['docker','start',container]); start=time.monotonic(); status={}; peak=0
            runtime_sha=output(['docker','exec',container,'sha256sum','/opt/teamaibox/phone_runtime.py']).split()[0]
            report['sourceDigests']['runtime']=runtime_sha
            report['sourceDigests']['mediaControl']=output(['docker','exec',container,'sha256sum','/opt/teamaibox/phone_media_control.py']).split()[0]
            report['sourceDigests']['adbControl']=output(['docker','exec',container,'sha256sum','/opt/teamaibox/phone_adb_control.py']).split()[0]
            report['sourceDigests']['fileWorker']=output(['docker','exec',container,'sha256sum','/opt/teamaibox/phone_files.py']).split()[0]
            report['sourceDigests']['streamerWrapper']=output(['docker','exec',container,'sha256sum','/opt/cuttlefish/bin/webRTC']).split()[0]
            while time.monotonic()-start < 360:
                state=json.loads(output(['docker','inspect',container]))[0]['State']
                if (data/'.phone-status.json').exists(): status=json.loads((data/'.phone-status.json').read_text())
                if not state['Running']: break
                metrics=command(['docker','exec',container,'cat','/sys/fs/cgroup/memory.peak'],check=False)
                if metrics.returncode==0: peak=max(peak,int(metrics.stdout))
                host=read_host()
                if host['available']<16*1024**3: raise RuntimeError('runtime_memory_pressure')
                if status.get('runId')==declaration['runId'] and status.get('phase')=='running': break
                time.sleep(2)
            record=dict(cycle=cycle,containerId=container,bootSeconds=round(time.monotonic()-start,3),
                        peakBytes=peak,status=status,security=security,containerState={k:state[k] for k in ('Running','ExitCode','OOMKilled')})
            report['cycles'].append(record)
            if status.get('phase')!='running' or not state['Running']:
                # These are synthetic runs; only matching runtime failure lines,
                # not guest contents, are retained in the portable report.
                log=data/'.launch.log'
                if log.exists(): record['launchErrors']=[line[:400] for line in log.read_text(errors='replace').splitlines()
                    if any(word in line.lower() for word in ('error','failed','fatal','denied','cannot','could not'))][-20:]
                raise RuntimeError('android_not_ready')
            prefix=['docker','exec',container,'/opt/cuttlefish/bin/adb','-s','127.0.0.1:6540']
            # A 64-bit Android ID is a hex number, not a promise of zero-padding.
            # Settings may also finish initializing just after boot_completed.
            identity_deadline=time.monotonic()+20
            while True:
                current_id=output([*prefix,'shell','settings','get','secure','android_id'])
                if re.fullmatch('[0-9a-f]{1,16}',current_id): break
                if time.monotonic()>=identity_deadline:
                    record['identityDiagnostic']={'length':len(current_id),'null':current_id=='null','empty':not current_id}
                    raise RuntimeError('android_identity_missing')
                time.sleep(1)
            if cycle==1:
                android_id=current_id
                # adb shell joins arguments; a nested sh -c loses the intended
                # command boundary. Transfer exact bytes instead of shell text.
                (data/'exchange/qualification.txt').write_bytes(b'synthetic-persistent-phone\n')
                os.chown(data/'exchange/qualification.txt',10001,10001)
                output([*prefix,'push','/phone/exchange/qualification.txt','/sdcard/teamaibox-runtime-test.txt'])
            elif current_id!=android_id: raise RuntimeError('android_identity_changed')
            if output([*prefix,'shell','cat','/sdcard/teamaibox-runtime-test.txt'])!='synthetic-persistent-phone':
                raise RuntimeError('android_file_not_persistent')
            record['androidIdentityStable']=True; record['syntheticFilePresent']=True
            record['androidIdSha256']=hashlib.sha256(current_id.encode()).hexdigest()
            record['syntheticFileSha256']=output([*prefix,'shell','sha256sum','/sdcard/teamaibox-runtime-test.txt']).split()[0]
            media_probe=Path(__file__).with_name('probe_cuttlefish_phone_media.py').read_bytes()
            report['sourceDigests']['mediaProbe']=hashlib.sha256(media_probe).hexdigest()
            probe=command(['docker','exec','-i',container,'/usr/bin/python3','-'],timeout=45,data=media_probe,check=False)
            if probe.returncode:
                record['mediaProbeDiagnostic']=probe.stderr.decode(errors='replace')[-2000:]
                raise RuntimeError('media_control_probe_failed')
            record['mediaControlProbe']=json.loads(probe.stdout)
            adb_probe=Path(__file__).with_name('probe_cuttlefish_phone_adb.py').read_bytes()
            report['sourceDigests']['adbProbe']=hashlib.sha256(adb_probe).hexdigest()
            probe=command(['docker','exec','-i',container,'/usr/bin/python3','-'],timeout=60,data=adb_probe,check=False)
            if probe.returncode:
                record['adbProbeDiagnostic']=probe.stderr.decode(errors='replace')[-2000:]
                raise RuntimeError('adb_control_probe_failed')
            record['adbControlProbe']=json.loads(probe.stdout)
            files_probe=Path(__file__).with_name('probe_cuttlefish_phone_files.py').read_bytes()
            report['sourceDigests']['fileProbe']=hashlib.sha256(files_probe).hexdigest()
            report['sourceDigests']['fileFixture']=hashlib.sha256(file_fixture.read_bytes()).hexdigest()
            probe=command(['docker','exec','-i',container,'/usr/bin/python3','-'],timeout=180,data=files_probe,check=False)
            if probe.returncode:
                record['fileProbeDiagnostic']=probe.stderr.decode(errors='replace')[-2000:]
                raise RuntimeError('file_control_probe_failed')
            record['fileControlProbe']=json.loads(probe.stdout)
            if output([*prefix,'shell','getprop','sys.boot_completed'])!='1' or output([*prefix,'shell','sha256sum','/sdcard/teamaibox-runtime-test.txt']).split()[0]!=record['syntheticFileSha256']:
                raise RuntimeError('android_changed_after_media_revocation')
            output(['docker','stop','--time','75',container],timeout=90)
            stopped=json.loads(output(['docker','inspect',container]))[0]['State']
            terminal=json.loads((data/'.phone-status.json').read_text()); record['terminal']=terminal
            if stopped['Running'] or stopped['OOMKilled'] or stopped['ExitCode']!=0 or not terminal.get('cleanShutdown'):
                raise RuntimeError('unclean_android_shutdown')
        report['passed']=True
    except Exception as error:
        report['failure']=str(error) if isinstance(error,(ValueError,RuntimeError)) else type(error).__name__
    finally:
        clean=True
        for container in containers:
            try:
                item=json.loads(output(['docker','inspect',container]))[0]
                if item['Id']!=container or item['Image']!=image_id or item['Config']['Labels'].get('teamaibox.phone-qualification')!=run_id:
                    raise RuntimeError('cleanup_container_identity_mismatch')
                command(['docker','stop','--time','75',container],timeout=90,check=False)
                item=json.loads(output(['docker','inspect',container]))[0]
                if item['State']['Running']: raise RuntimeError('container_still_running')
                output(['docker','rm',container])
            except Exception: clean=False
        report['cleanup']['containersRemoved']=clean
        if mounted and clean:
            try:
                if (backing.stat().st_dev,backing.stat().st_ino)!=backing_identity: raise RuntimeError('backing_changed')
                if os.path.realpath(output(['findmnt','-n','-o','SOURCE','--mountpoint',mount]))!=os.path.realpath(mapped):
                    raise RuntimeError('mount_changed')
                command(['umount',mount]); mounted=False
            except Exception: clean=False
        if opened and not mounted and clean:
            try: command(['cryptsetup','close',mapper]); opened=False
            except Exception: clean=False
        key=None
        report['cleanup'].update(unmounted=not mounted,mappingClosed=not opened,keyRetained=False)
        after=inventory()
        report['originalServicesUnchanged']=all(after.get(key)==value for key,value in before.items())
        report['originalServiceCount']=len(before)
        report['passed']=report['passed'] and clean and report['originalServicesUnchanged']
        report['finishedAtUnix']=time.time()
        evidence=root/'result.json'
        with evidence.open('x') as stream: json.dump(report,stream,indent=2); stream.flush(); os.fsync(stream.fileno())
    print(json.dumps(report,indent=2))
    return 0 if report['passed'] else 1


if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('--run-id',required=True); parser.add_argument('--image-id',required=True)
    parser.add_argument('--file-fixture',type=Path,required=True)
    args=parser.parse_args(); raise SystemExit(run(args.run_id,args.image_id,args.file_fixture))

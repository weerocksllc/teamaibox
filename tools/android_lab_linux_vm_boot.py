#!/usr/bin/env python3
"""Run a private ARM KVM Linux VM; all privileged Android work stays in the guest."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import time


def command(args, timeout=60, check=True, input=None):
    p=subprocess.run(args,input=input,text=True,capture_output=True,timeout=timeout)
    if check and p.returncode:
        raise RuntimeError(str(args[0])+': '+p.stderr[-1500:])
    return p


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--run-id',required=True)
    parser.add_argument('--redroid-archive')
    parser.add_argument('--base-disk')
    parser.add_argument('--waydroid',action='store_true')
    parser.add_argument('--prepared-guest-script')
    args=parser.parse_args()
    if args.waydroid and args.redroid_archive:raise ValueError('one backend per run')
    if not re.fullmatch(r'android-lab-linux-vm-boot-\d{8}-a[1-9]\d*',args.run_id):
        raise ValueError('invalid run')
    root=Path('/lab')/args.run_id
    root.mkdir(mode=0o700)
    private=root/'private'; private.mkdir(mode=0o700)
    report={'runId':args.run_id,'androidBooted':False,'linuxBooted':False,
            'vmMemoryMiB':6144,'androidLimitGiB':4,'hardwareGraphicsAccepted':False,
            'gpuPassthrough':False,'hostKernelMutation':False,'startedUnix':time.time()}
    proc=None
    for name in ('client','server'):
        command(['ssh-keygen','-q','-t','ed25519','-N','','-f',str(private/name)])
    public=(private/'server.pub').read_text().strip()
    (private/'known_hosts').write_text('[127.0.0.1]:2222 '+public+'\n')
    user={'name':'lab','groups':['sudo'],'shell':'/bin/bash','sudo':'ALL=(ALL) NOPASSWD:ALL',
          'lock_passwd':True,'ssh_authorized_keys':[(private/'client.pub').read_text().strip()]}
    config={'users':[user],'ssh_pwauth':False,'disable_root':True,'ssh_deletekeys':False,
      'write_files':[{'path':'/etc/ssh/ssh_host_ed25519_key','owner':'root:root','permissions':'0600',
                      'content':(private/'server').read_text()},
                     {'path':'/etc/ssh/ssh_host_ed25519_key.pub','permissions':'0644','content':public+'\n'}],
      'runcmd':[['systemctl','restart','ssh']]}
    (private/'user-data').write_text('#cloud-config\n'+json.dumps(config))
    (private/'meta-data').write_text(json.dumps({'instance-id':args.run_id,'local-hostname':'android-lab'}))
    command(['genisoimage','-quiet','-output',str(private/'seed.iso'),'-volid','cidata','-joliet','-rock',
             str(private/'user-data'),str(private/'meta-data')])
    base=Path(args.base_disk) if args.base_disk else Path('/lab/debian-13-generic-arm64-20260831-2587.qcow2')
    if args.base_disk and (base.name!='disk.qcow2' or base.parent.parent!=Path('/lab')
            or not re.fullmatch(r'android-lab-linux-vm-boot-\d{8}-a[1-9]\d*',base.parent.name)):
        raise ValueError('base disk must be an exact prior lab VM disk')
    if args.prepared_guest_script:
        script_path=Path(args.prepared_guest_script)
        if not args.base_disk or not args.waydroid or script_path.parent!=Path('/lab') or not re.fullmatch(r'waydroid-followup-a[1-9]\d*\.sh',script_path.name):
            raise ValueError('prepared follow-up requires an owned Waydroid script and prior disk')
        parent=json.loads((base.parent/'result.json').read_text())
        if parent.get('status')!='passed' or not parent.get('qemuStopped') or not parent.get('androidBooted'):
            raise ValueError('prepared disk must come from a completed successful Android run')
        report['preparedParentRun']=parent['runId']
        report['guestScriptSha256']=hashlib.sha256(script_path.read_bytes()).hexdigest()
    disk=root/'disk.qcow2'
    command(['qemu-img','create','-f','qcow2','-F','qcow2','-b',str(base),str(disk),'24G'])
    ssh=['ssh','-i',str(private/'client'),'-p','2222','-o','BatchMode=yes','-o','ConnectTimeout=5',
         '-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile='+str(private/'known_hosts'),'lab@127.0.0.1']
    def guest(script,timeout=120,check=True):
        # Do not put shell source on stdin: adb/LXC may otherwise consume the
        # remaining test commands as their own input and falsely return success.
        return command([*ssh,'bash -c '+shlex.quote(script)],timeout=timeout,check=check)
    try:
        with (root/'serial.log').open('w') as serial:
            qemu=['qemu-system-aarch64','-machine','virt,gic-version=3','-accel','kvm','-cpu','host',
              '-smp','4','-m','6144','-bios','/usr/share/qemu-efi-aarch64/QEMU_EFI.fd',
              '-drive','file='+str(disk)+',if=virtio,format=qcow2,cache=none',
              '-drive','file='+str(private/'seed.iso')+',if=virtio,format=raw,readonly=on',
              '-netdev','user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22',
              '-device','virtio-net-pci,netdev=net0,romfile=','-nographic','-monitor','none']
            report['qemuArguments']=qemu
            started=time.monotonic()
            proc=subprocess.Popen(qemu,stdout=serial,stderr=subprocess.STDOUT)
        for _ in range(60):
            if proc.poll() is not None: raise RuntimeError('QEMU exited '+str(proc.returncode))
            p=guest('uname -a; cat /proc/meminfo | head -4',check=False)
            if p.returncode==0:
                report.update(linuxBooted=True,linuxBootSeconds=time.monotonic()-started,linuxIdentity=p.stdout)
                break
            time.sleep(3)
        if not report['linuxBooted']: raise RuntimeError('Linux SSH deadline')
        print(json.dumps({'linuxBooted':True,'seconds':report['linuxBootSeconds']}),flush=True)
        setup_script='''set -eu
sudo cloud-init status --wait
sudo env DEBIAN_FRONTEND=noninteractive apt-get update -qq
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends docker.io docker-cli adb kmod curl unzip
sudo systemctl start docker
sudo modprobe binder_linux devices=binder,hwbinder,vndbinder
sudo chmod 0666 /dev/binder /dev/hwbinder /dev/vndbinder
uname -a
ls -l /dev/binder /dev/hwbinder /dev/vndbinder
sudo docker info --format '{{.Architecture}} {{.CgroupVersion}}'
'''
        if args.prepared_guest_script:
            setup_script='''set -eu
sudo cloud-init status --wait
sudo modprobe binder_linux devices=binder,hwbinder,vndbinder
sudo chmod 0666 /dev/binder /dev/hwbinder /dev/vndbinder
uname -a
test -f /var/lib/waydroid/waydroid.cfg
'''
        setup=guest(setup_script,timeout=600,check=False)
        (root/'setup.stdout').write_text(setup.stdout)
        (root/'setup.stderr').write_text(setup.stderr)
        report['guestSetupExit']=setup.returncode
        if setup.returncode: raise RuntimeError('guest setup failed; inspect bounded setup logs')
        if args.redroid_archive:
            archive=Path(args.redroid_archive)
            if archive.parent!=Path('/lab') or not archive.is_file(): raise ValueError('owned archive required')
            scp=['scp','-q','-i',str(private/'client'),'-P','2222','-o','StrictHostKeyChecking=yes',
                 '-o','UserKnownHostsFile='+str(private/'known_hosts'),str(archive),'lab@127.0.0.1:/home/lab/redroid.tar']
            command(scp,timeout=240)
            start=guest('''set -eu
sudo docker load -i /home/lab/redroid.tar
sudo docker image inspect --format '{{.Id}} {{.Architecture}}' teamaibox/android-lab-redroid:20260911-a1
sudo docker run -d --name android-lab-redroid --privileged --memory 4g --memory-swap 4g --cpus 4 --pids-limit 2048 --restart no -p 127.0.0.1:5555:5555 -v android-lab-redroid-data:/data sha256:e4450fd64bbb56954297906128cb9da9a66ff8063c5b9cac5c3e1f95ab229333 androidboot.use_memfd=1 androidboot.redroid_width=720 androidboot.redroid_height=1280 androidboot.redroid_dpi=320 androidboot.redroid_fps=30 androidboot.redroid_gpu_mode=guest
''',timeout=180,check=False)
            (root/'redroid-start.stdout').write_text(start.stdout)
            (root/'redroid-start.stderr').write_text(start.stderr)
            if start.returncode: raise RuntimeError('ReDroid start failed')
            android_started=time.monotonic()
            for _ in range(60):
                state=guest('adb connect 127.0.0.1:5555 >/dev/null 2>&1; timeout 5 adb -s 127.0.0.1:5555 shell -n getprop sys.boot_completed',check=False)
                if state.stdout.strip()=='1':
                    report.update(androidBooted=True,androidBootSeconds=time.monotonic()-android_started)
                    break
                time.sleep(3)
            diag=guest('''sudo docker inspect --format '{{json .State}}' android-lab-redroid
sudo docker stats --no-stream --format '{{.MemUsage}} {{.CPUPerc}}' android-lab-redroid
timeout 10 adb -s 127.0.0.1:5555 shell -n getprop
timeout 10 adb -s 127.0.0.1:5555 shell -n dumpsys SurfaceFlinger
sudo docker logs --tail 150 android-lab-redroid
sudo docker exec android-lab-redroid logcat -d -b crash -t 150
sudo journalctl -k -b --no-pager -n 80
''',check=False)
            (root/'redroid-diagnostics.log').write_text(diag.stdout+'\n'+diag.stderr)
            if not report['androidBooted']: raise RuntimeError('ReDroid boot deadline')
            shot=guest('''set -eu
adb -s 127.0.0.1:5555 shell -n am start -a android.settings.SETTINGS
sleep 2
adb -s 127.0.0.1:5555 shell -n screencap -p /sdcard/android-lab-settings.png
adb -s 127.0.0.1:5555 pull /sdcard/android-lab-settings.png /home/lab/settings.png
''',check=False)
            report['settingsCaptureExit']=shot.returncode
            (root/'settings-capture.stdout').write_text(shot.stdout)
            (root/'settings-capture.stderr').write_text(shot.stderr)
            if shot.returncode==0:
                command(['scp','-q','-i',str(private/'client'),'-P','2222','-o','StrictHostKeyChecking=yes',
                  '-o','UserKnownHostsFile='+str(private/'known_hosts'),'lab@127.0.0.1:/home/lab/settings.png',str(root/'settings.png')])
            print(json.dumps({'androidBooted':True,'seconds':report['androidBootSeconds']}),flush=True)
        if args.waydroid and not args.prepared_guest_script:
            for name in ('system','vendor'):
                command(['scp','-q','-i',str(private/'client'),'-P','2222','-o','StrictHostKeyChecking=yes',
                  '-o','UserKnownHostsFile='+str(private/'known_hosts'),'/lab/waydroid64-20260403/'+name+'.zip',
                  'lab@127.0.0.1:/home/lab/waydroid64-'+name+'.zip'],timeout=240)
            command(['scp','-q','-i',str(private/'client'),'-P','2222','-o','StrictHostKeyChecking=yes',
              '-o','UserKnownHostsFile='+str(private/'known_hosts'),'/lab/waydroid-adb-provision-a1.py',
              'lab@127.0.0.1:/home/lab/waydroid-adb-authorize.py'])
            script=Path('/lab/waydroid64-guest-a5.sh').read_text()
            waydroid=guest(script,timeout=840,check=False)
            (root/'waydroid.stdout').write_text(waydroid.stdout)
            (root/'waydroid.stderr').write_text(waydroid.stderr)
            report['waydroidExitCode']=waydroid.returncode
            report['androidBooted']='ANDROID_LAB_WAYDROID_BOOTED' in waydroid.stdout
            report['waydroidImageVariant']='arm64_only'
            if waydroid.returncode or not report['androidBooted']:raise RuntimeError('Waydroid test failed; inspect guest logs')
            command(['scp','-q','-i',str(private/'client'),'-P','2222','-o','StrictHostKeyChecking=yes',
              '-o','UserKnownHostsFile='+str(private/'known_hosts'),'lab@127.0.0.1:/home/lab/settings.png',str(root/'settings.png')])
            if (root/'settings.png').read_bytes()[:8]!=b'\x89PNG\r\n\x1a\n':
                raise RuntimeError('Waydroid screenshot is not a PNG')
        if args.prepared_guest_script:
            waydroid=guest(Path(args.prepared_guest_script).read_text(),timeout=1200,check=False)
            (root/'waydroid.stdout').write_text(waydroid.stdout)
            (root/'waydroid.stderr').write_text(waydroid.stderr)
            report['waydroidExitCode']=waydroid.returncode
            report['androidBooted']='ANDROID_LAB_WAYDROID_BOOTED' in waydroid.stdout
            report['waydroidImageVariant']='arm64_only'
            if waydroid.returncode or not report['androidBooted']:
                raise RuntimeError('prepared Waydroid follow-up failed; inspect guest logs')
        report['status']='passed'
    except subprocess.TimeoutExpired as exc:
        for name, data in (('timeout.stdout',exc.stdout),('timeout.stderr',exc.stderr)):
            raw=data.encode() if isinstance(data,str) else (data or b'')
            (root/name).write_bytes(raw[-4*1024*1024:])
        report.update(status='failed',error='test subprocess exceeded '+str(exc.timeout)+' seconds')
    except Exception as exc:
        report.update(status='failed',error=str(exc)[:1500])
    finally:
        if proc and proc.poll() is None:
            try: guest('sudo poweroff',timeout=10,check=False)
            except subprocess.TimeoutExpired: report['guestShutdownTimedOut']=True
            try: proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                proc.terminate()
                try: proc.wait(timeout=5)
                except subprocess.TimeoutExpired: proc.kill();proc.wait(timeout=5)
        report['qemuStopped']=proc is None or proc.poll() is not None
        report['durationSeconds']=time.time()-report['startedUnix']
        with (root/'result.json').open('x') as out: json.dump(report,out,indent=2)
        print(json.dumps(report),flush=True)
    return 0 if report['status']=='passed' else 1


if __name__=='__main__':
    raise SystemExit(main())

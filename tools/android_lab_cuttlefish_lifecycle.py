#!/usr/bin/env python3
"""Ten private KVM phone starts with persistent files and browser receipts."""
import argparse
import base64
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import subprocess
import time
import urllib.request

APK_URL='https://github.com/FossifyOrg/Calculator/releases/download/1.4.0/calculator-10-foss-release.apk'
APK_SHA='7c5443c22d6d62c67dfe80df33ea9161ff0fa440f92590bcb45d7008b57613ed'


def owned_android_vm(cmd,artifacts):
    return (bool(cmd) and cmd[0] in (str(artifacts/'bin/crosvm').encode(),str(artifacts/'bin/aarch64-linux-musl/crosvm').encode())
            and b'run' in cmd and b'--socket=/tmp/cf_avd_0/cvd-21/internal/crosvm_control.sock' in cmd)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--run-id',required=True);args=parser.parse_args()
    if not re.fullmatch(r'android-lab-cuttlefish-lifecycle-\d{8}-a[1-9]\d*',args.run_id):raise ValueError('exact run required')
    resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_NOFILE,(8192,8192))
    root=Path('/lab')/args.run_id;root.mkdir(exist_ok=False);artifacts=root/'artifacts'
    report={'runId':args.run_id,'startedUnix':time.time(),'cycles':[],'status':'running','hardwareGraphicsAccepted':False}
    procs=[]; launch_attempted=False
    def result(name,data):
        with (root/name).open('x') as stream:json.dump(data,stream,indent=2)
    def command(cmd,timeout=45):return subprocess.run(cmd,capture_output=True,text=True,timeout=timeout)
    def checked(cmd,timeout=45):
        r=command(cmd,timeout)
        if r.returncode:raise RuntimeError(str(cmd[:3])+': '+r.stderr[-1500:]+' '+r.stdout[-500:])
        return r.stdout
    try:
        subprocess.run(['cp','--reflink=auto','-a','/lab/cf-a3',str(artifacts)],check=True)
        for p in artifacts.rglob('*'):
            if p.is_file() and not p.is_symlink():
                with p.open('rb',buffering=0) as f:os.posix_fadvise(f.fileno(),0,0,os.POSIX_FADV_DONTNEED)
        assets=artifacts/'usr/share/webrtc/assets';jquery=Path('/lab/'+args.run_id+'.jquery.js').read_bytes()
        if hashlib.sha256(jquery).hexdigest()!='ff1523fb7389539c84c65aba19260648793bb4f5e29329d2ee8804bc37a3fe6e':raise RuntimeError('jQuery mismatch')
        client=assets/'client.html';before=client.read_bytes()
        text=before.decode().replace('https://ajax.googleapis.com/ajax/libs/jquery/3.6.0/jquery.min.js','jquery-3.6.0.min.js')
        client.write_text(re.sub(r'\s*<link[^>]+href="https://fonts.googleapis.com/[^>]+>','',text))
        (assets/'jquery-3.6.0.min.js').write_bytes(jquery)
        report['clientPatch']={'before':hashlib.sha256(before).hexdigest(),'after':hashlib.sha256(client.read_bytes()).hexdigest()}
        (root/'runtime').mkdir();Path('/root/cuttlefish').symlink_to(root/'runtime')
        os.environ.update(ANDROID_HOST_OUT=str(artifacts),ANDROID_PRODUCT_OUT=str(artifacts),PATH=str(artifacts/'bin')+':'+os.environ['PATH'])
        checked(['install','-D','-m','755','/lab/capability_query.py','/usr/lib/cuttlefish-common/bin/capability_query.py'])
        for group in ('kvm','cvdnetwork','render'):
            if command(['getent','group',group]).returncode:checked(['groupadd',group])
        with open('/dev/kvm','rb',buffering=0) as f:
            report['kvmApi']=fcntl.ioctl(f,0xAE00,0);vm=fcntl.ioctl(f,0xAE01,0);os.close(vm)
        launch=[str(artifacts/'bin/launch_cvd'),'--daemon=true','--report_anonymous_usage_stats=n','--cpus=4','--memory_mb=4096',
            '--x_res=720','--y_res=1280','--dpi=320','--refresh_rate_hz=30','--gpu_mode=guest_swiftshader','--enable_sandbox=false',
            '--vm_manager=crosvm','--start_webrtc=true','--enable_tap_devices=false','--vhost_net=false','--netsim=false',
            '--netsim_bt=false','--netsim_uwb=false','--enable_modem_simulator=false','--num_instances=1','--base_instance_num=21',
            '--vsock_guest_cid=2121','--resume=true','--system_image_dir='+str(artifacts)]
        report['launchArguments']=launch
        adb=lambda *a:checked([str(artifacts/'bin/adb'),*a])
        # Lifecycle must not depend on a third-party APK download. That is a separate test.
        apk_source=Path('/lab/'+args.run_id+'.calculator.apk')
        app_package='com.android.settings'
        report['testApp']={'package':app_package,'source':'same pinned AOSP image',
            'thirdPartyInstallAccepted':False,'deferredApkUrl':APK_URL,'deferredApkSha256':APK_SHA}
        if apk_source.exists():
            data=apk_source.read_bytes()
            if len(data)!=7047681 or hashlib.sha256(data).hexdigest()!=APK_SHA:raise RuntimeError('test APK mismatch')
            app_package='org.fossify.math'
            report['testApp']={'package':app_package,'url':APK_URL,'sha256':APK_SHA,'bytes':len(data),
                'thirdPartyInstallAccepted':False,'downloadPath':'controller verified HTTPS; no host installation'}
        marker=(args.run_id+'\npersistent synthetic data\n').encode();(root/'marker.txt').write_bytes(marker)
        marker_sha=hashlib.sha256(marker).hexdigest();report['markerSha256']=marker_sha
        for index in range(1,11):
            t=time.monotonic();cycle={'index':index,'startKind':'fresh-data' if index==1 else 'existing-data-resume'}
            report['currentCycle']=cycle
            with (root/f'launch-{index}.stdout').open('x') as out,(root/f'launch-{index}.stderr').open('x') as err:
                launch_attempted=True
                p=subprocess.run(launch,cwd=artifacts,stdout=out,stderr=err,timeout=180)
            if p.returncode:raise RuntimeError(f'cycle {index} launch failed')
            adb('connect','127.0.0.1:6540')
            deadline=time.monotonic()+90
            while time.monotonic()<deadline:
                p=command([str(artifacts/'bin/adb'),'shell','getprop','sys.boot_completed'])
                if p.returncode==0 and p.stdout.strip()=='1':break
                time.sleep(1)
            else:raise RuntimeError('Android boot incomplete')
            cycle['bootSeconds']=time.monotonic()-t;cycle['bootId']=adb('shell','cat','/proc/sys/kernel/random/boot_id').strip()
            cycle['androidId']=adb('shell','settings','get','secure','android_id').strip()
            adb('shell','input','keyevent','KEYCODE_WAKEUP');adb('shell','wm','dismiss-keyguard')
            adb('shell','input','swipe','360','1100','360','300','250')
            if index==1:
                if app_package=='org.fossify.math':
                    cycle['install']=adb('install',str(apk_source))
                    if 'Success' not in cycle['install']:raise RuntimeError('test app install failed')
                    report['testApp']['thirdPartyInstallAccepted']=True
                report['appPackageInfo']=adb('shell','dumpsys','package',app_package)
                report['properties']=adb('shell','getprop')
                report['packages']=adb('shell','pm','list','packages')
                adb('shell','settings','put','global','device_name','Team-AI-lab-phone')
                adb('push',str(root/'marker.txt'),'/data/local/tmp/cf-marker.txt')
                adb('push',str(root/'marker.txt'),'/sdcard/Download/cf-marker.txt')
                cycle['initialDataSync']=adb('shell','sync')
            cycle['privateSha']=adb('shell','sha256sum','/data/local/tmp/cf-marker.txt').split()[0]
            cycle['sharedSha']=adb('shell','sha256sum','/sdcard/Download/cf-marker.txt').split()[0]
            adb('pull','/sdcard/Download/cf-marker.txt',str(root/f'roundtrip-{index}.txt'))
            cycle['roundtripSha']=hashlib.sha256((root/f'roundtrip-{index}.txt').read_bytes()).hexdigest()
            result(f'files-{index}.json',{key:cycle[key] for key in ('index','bootId','androidId','privateSha','sharedSha','roundtripSha')})
            if any(cycle[k]!=marker_sha for k in ('privateSha','sharedSha','roundtripSha')):raise RuntimeError('file persistence mismatch')
            if app_package=='org.fossify.math':
                activity=adb('shell','cmd','package','resolve-activity','--brief','-a','android.intent.action.MAIN',
                    '-c','android.intent.category.LAUNCHER',app_package).strip().splitlines()[-1]
                if not activity.startswith(app_package+'/'):raise RuntimeError('unexpected test app launch target')
                cycle['appLaunch']=adb('shell','am','start','-W','-n',activity)
            else:cycle['appLaunch']=adb('shell','am','start','-W','-a','android.settings.SETTINGS')
            if 'Error' in cycle['appLaunch']:raise RuntimeError('test app launch failed')
            time.sleep(2)
            cycle['appFocus']=[line.strip() for line in adb('shell','dumpsys','window','displays').splitlines() if 'mCurrentFocus=' in line]
            if not any(app_package in line for line in cycle['appFocus']):raise RuntimeError('test app not focused')
            cycle['deviceName']=adb('shell','settings','get','global','device_name').strip()
            if cycle['deviceName']!='Team-AI-lab-phone':raise RuntimeError('configured device label not retained')
            if index==1:
                log=(root/'browser.log').open('x');cert=artifacts/'usr/share/webrtc/certs/server.crt'
                public=subprocess.check_output(['openssl','x509','-in',str(cert),'-pubkey','-noout'])
                der=subprocess.run(['openssl','pkey','-pubin','-outform','DER'],input=public,capture_output=True,check=True).stdout
                pin=base64.b64encode(hashlib.sha256(der).digest()).decode();report['testBrowserSpkiPin']=pin
                procs.append(subprocess.Popen(['chromium','--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage',
                    '--remote-debugging-port=9222','--ignore-certificate-errors-spki-list='+pin,'--user-data-dir='+str(root/'chrome'),'about:blank'],stdout=log,stderr=log))
                procs.append(subprocess.Popen(['socat','TCP-LISTEN:19222,bind=0.0.0.0,reuseaddr,fork','TCP:127.0.0.1:9222'],stdout=log,stderr=log))
                browser_deadline=time.monotonic()+15
                while time.monotonic()<browser_deadline:
                    try:
                        with urllib.request.urlopen('http://127.0.0.1:9222/json/version',timeout=1) as response:
                            if response.status==200:break
                    except OSError:time.sleep(.25)
                else:raise RuntimeError('private test browser did not become ready')
            result(f'ready-{index}.json',cycle);print('CYCLE_READY '+str(index),flush=True)
            deadline=time.monotonic()+60;receipt=root/f'browser-{index}.json'
            while not receipt.exists() and time.monotonic()<deadline:time.sleep(1)
            if not receipt.exists():raise RuntimeError('browser observer deadline')
            cycle['browser']=json.loads(receipt.read_text())
            if cycle['browser'].get('status')!='passed' or cycle['browser'].get('runId')!=args.run_id or cycle['browser'].get('cycle')!=index:
                raise RuntimeError('browser cycle did not pass')
            # Cycle 5 simulates only this private VM process dying, never a host/GPU reset.
            if index==5:
                found=[]
                for proc in Path('/proc').iterdir():
                    if not proc.name.isdigit():continue
                    try:
                        cmd=(proc/'cmdline').read_bytes().split(b'\0')
                        if owned_android_vm(cmd,artifacts):found.append(int(proc.name))
                    except (OSError,UnicodeError):pass
                if len(found)!=1:raise RuntimeError('cannot identify one exact private crosvm process for crash test')
                cycle['forcedVmExitPid']=found[0];os.kill(found[0],9);time.sleep(2)
            else:
                # stop_cvd ends VM processes. Flush guest data before a normal stop.
                # The forced-crash case deliberately does not do this pre-stop flush.
                cycle['normalStopDataSync']=adb('shell','sync')
            stopped=command([str(artifacts/'bin/stop_cvd')],timeout=30);cycle['stopExit']=stopped.returncode
            if stopped.returncode:raise RuntimeError('stop_cvd failed')
            report['cycles'].append(cycle);result(f'cycle-{index}.json',cycle)
        if len({c['bootId'] for c in report['cycles']})!=10:raise RuntimeError('ten distinct guest boots required')
        if len({c['androidId'] for c in report['cycles']})!=1:raise RuntimeError('Android identity changed')
        report['status']='passed'
    except Exception as exc:report.update(status='failed',error=str(exc))
    finally:
        for p in procs:
            p.terminate()
            try:p.wait(timeout=5)
            except subprocess.TimeoutExpired:p.kill()
        if launch_attempted and (artifacts/'bin/stop_cvd').exists():
            report['finalStopExit']=command([str(artifacts/'bin/stop_cvd')],timeout=30).returncode
        else:report['finalStopSkipped']='guest launch was never attempted'
        report['finishedUnix']=time.time();result('result.json',report)
        print(json.dumps({k:report.get(k) for k in ('runId','status','error')}),flush=True)
    return 0 if report['status']=='passed' else 1


if __name__=='__main__':raise SystemExit(main())

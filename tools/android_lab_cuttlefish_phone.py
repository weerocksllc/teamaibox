#!/usr/bin/env python3
"""One phone for the two-container isolation trial; only synthetic input/data."""
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
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer


def main():
    p=argparse.ArgumentParser();p.add_argument('--run-id',required=True);p.add_argument('--instance',type=int,choices=(21,22),required=True);args=p.parse_args()
    if not re.fullmatch(r'android-lab-cf-pair-\d{8}-a[1-9]\d*-p[12]',args.run_id):raise ValueError('exact phone identity required')
    resource.setrlimit(resource.RLIMIT_CORE,(0,0));resource.setrlimit(resource.RLIMIT_NOFILE,(8192,8192))
    root=Path('/lab')/args.run_id;root.mkdir(exist_ok=False);art=root/'artifacts'
    report={'runId':args.run_id,'instance':args.instance,'status':'running','renderer':'guest_swiftshader','hardwareGraphicsAccepted':False}
    procs=[];server=None;launched=False
    def save(name,obj):
        with (root/name).open('x') as f:json.dump(obj,f,indent=2)
    def cmd(argv,timeout=40):return subprocess.run(argv,capture_output=True,text=True,timeout=timeout)
    def checked(argv,timeout=40):
        r=cmd(argv,timeout)
        if r.returncode:raise RuntimeError(str(argv[:2])+': '+r.stderr[-1000:]+r.stdout[-500:])
        return r.stdout
    try:
        subprocess.run(['cp','--reflink=auto','-a','/lab/cf-a3',str(art)],check=True)
        for path in art.rglob('*'):
            if path.is_file() and not path.is_symlink():
                with path.open('rb',buffering=0) as f:os.posix_fadvise(f.fileno(),0,0,os.POSIX_FADV_DONTNEED)
        (root/'runtime').mkdir();Path('/root/cuttlefish').symlink_to(root/'runtime')
        os.environ.update(ANDROID_HOST_OUT=str(art),ANDROID_PRODUCT_OUT=str(art),PATH=str(art/'bin')+':'+os.environ['PATH'])
        checked(['install','-D','-m','755','/lab/capability_query.py','/usr/lib/cuttlefish-common/bin/capability_query.py'])
        for group in ('kvm','cvdnetwork','render'):
            if cmd(['getent','group',group]).returncode:checked(['groupadd',group])
        with open('/dev/kvm','rb',buffering=0) as f:
            report['kvmApi']=fcntl.ioctl(f,0xAE00,0);vm=fcntl.ioctl(f,0xAE01,0);os.close(vm)
        jquery=Path('/lab/'+args.run_id+'.jquery.js').read_bytes()
        if hashlib.sha256(jquery).hexdigest()!='ff1523fb7389539c84c65aba19260648793bb4f5e29329d2ee8804bc37a3fe6e':raise RuntimeError('jquery mismatch')
        assets=art/'usr/share/webrtc/assets';client=assets/'client.html'
        text=client.read_text().replace('https://ajax.googleapis.com/ajax/libs/jquery/3.6.0/jquery.min.js','jquery-3.6.0.min.js')
        client.write_text(re.sub(r'\s*<link[^>]+href="https://fonts.googleapis.com/[^>]+>','',text));(assets/'jquery-3.6.0.min.js').write_bytes(jquery)
        launch=[str(art/'bin/launch_cvd'),'--daemon=true','--report_anonymous_usage_stats=n','--cpus=4','--memory_mb=4096',
          '--x_res=720','--y_res=1280','--dpi=320','--refresh_rate_hz=30','--gpu_mode=guest_swiftshader','--enable_sandbox=false',
          '--vm_manager=crosvm','--start_webrtc=true','--enable_tap_devices=false','--vhost_net=false','--netsim=false',
          '--netsim_bt=false','--netsim_uwb=false','--enable_modem_simulator=true','--num_instances=1',
          '--base_instance_num='+str(args.instance),'--vsock_guest_cid='+str(2100+args.instance),'--system_image_dir='+str(art)]
        report['launch']=launch;t=time.monotonic();launched=True
        with (root/'launch.stdout').open('x') as out,(root/'launch.stderr').open('x') as err:
            done=subprocess.run(launch,cwd=art,stdout=out,stderr=err,timeout=180)
        if done.returncode:raise RuntimeError('phone launch failed')
        serial='127.0.0.1:'+str(6519+args.instance)
        checked([str(art/'bin/adb'),'connect',serial])
        adb=lambda *a:checked([str(art/'bin/adb'),'-s',serial,*a])
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            if adb('shell','getprop','sys.boot_completed').strip()=='1':break
            time.sleep(1)
        else:raise RuntimeError('guest boot incomplete')
        report['bootSeconds']=time.monotonic()-t;report['serial']=serial
        report['androidId']=adb('shell','settings','get','secure','android_id').strip()
        report['propertyConfiguration']=[]
        for key,value in (('ro.product.model','Team-AI-Lab-Phone'),('ro.product.manufacturer','TeamAIBox')):
            original=adb('shell','getprop',key).strip()
            attempted=cmd([str(art/'bin/adb'),'-s',serial,'shell','setprop',key,value])
            report['propertyConfiguration'].append({'property':key,'before':original,'requested':value,
                'exit':attempted.returncode,'stdout':attempted.stdout,'stderr':attempted.stderr,'after':adb('shell','getprop',key).strip()})
        marker=(args.run_id+' synthetic per-phone data\n').encode();(root/'marker.txt').write_bytes(marker)
        target='/sdcard/Download/phone-'+str(args.instance)+'.txt';other='/sdcard/Download/phone-'+str(43-args.instance)+'.txt'
        adb('push',str(root/'marker.txt'),target);adb('shell','sync')
        def files():
            value={'sha256':adb('shell','sha256sum',target).split()[0],
                'otherFileAbsent':cmd([str(art/'bin/adb'),'-s',serial,'shell','test','!','-e',other]).returncode==0,
                'hostLabPathAbsent':cmd([str(art/'bin/adb'),'-s',serial,'shell','test','!','-e','/lab']).returncode==0}
            pulled=root/('roundtrip-'+str(time.monotonic_ns())+'.txt');adb('pull',target,str(pulled))
            value['roundtripSha256']=hashlib.sha256(pulled.read_bytes()).hexdigest()
            if value['sha256']!=hashlib.sha256(marker).hexdigest() or value['roundtripSha256']!=value['sha256'] or not value['otherFileAbsent'] or not value['hostLabPathAbsent']:
                raise RuntimeError('guest file isolation failed')
            return value
        report['filesBefore']=files();report['markerSha256']=hashlib.sha256(marker).hexdigest()
        fixture=root/'fixture';fixture.mkdir();data=Path('/lab/'+args.run_id+'.fixture.html').read_bytes();(fixture/'index.html').write_bytes(data)
        class Quiet(SimpleHTTPRequestHandler):
            def log_message(self,*a):pass
        server=ThreadingHTTPServer(('127.0.0.1',8128),partial(Quiet,directory=str(fixture)))
        threading.Thread(target=server.serve_forever,daemon=True).start()
        adb('reverse','tcp:8128','tcp:8128');adb('shell','input','keyevent','KEYCODE_WAKEUP');adb('shell','wm','dismiss-keyguard')
        adb('shell','input','swipe','360','1100','360','300','250')
        report['fixtureLaunch']=adb('shell','am','start','-W','-a','android.intent.action.VIEW','-d','http://127.0.0.1:8128/')
        time.sleep(2)
        pid=adb('shell','pidof','org.chromium.webview_shell').strip()
        if not pid.isdigit():raise RuntimeError('synthetic WebView missing')
        adb('forward','tcp:9223','localabstract:webview_devtools_remote_'+pid)
        log=(root/'browser.log').open('x')
        procs.append(subprocess.Popen(['socat','TCP-LISTEN:19223,bind=0.0.0.0,reuseaddr,fork','TCP:127.0.0.1:9223'],stdout=log,stderr=log))
        public=subprocess.check_output(['openssl','x509','-in',str(art/'usr/share/webrtc/certs/server.crt'),'-pubkey','-noout'])
        der=subprocess.run(['openssl','pkey','-pubin','-outform','DER'],input=public,capture_output=True,check=True).stdout
        pin=base64.b64encode(hashlib.sha256(der).digest()).decode();report['testSpkiPin']=pin
        procs.append(subprocess.Popen(['chromium','--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port=9222',
            '--ignore-certificate-errors-spki-list='+pin,'--user-data-dir='+str(root/'chrome'),'about:blank'],stdout=log,stderr=log))
        procs.append(subprocess.Popen(['socat','TCP-LISTEN:19222,bind=0.0.0.0,reuseaddr,fork','TCP:127.0.0.1:9222'],stdout=log,stderr=log))
        time.sleep(2);save('ready.json',report)
        deadline=time.monotonic()+300
        while time.monotonic()<deadline and not (root/'stop.request.json').exists():time.sleep(1)
        if not (root/'stop.request.json').exists():raise RuntimeError('browser isolation trial deadline')
        receipt=json.loads((root/'stop.request.json').read_text())
        if receipt.get('runId')!=args.run_id or receipt.get('status')!='passed':raise RuntimeError('browser trial failed')
        report['browserReceipt']=receipt;report['filesAfter']=files();adb('shell','sync');report['status']='passed'
    except Exception as e:report.update(status='failed',error=str(e))
    finally:
        if launched:
            # Synthetic guest only. Preserve app exit diagnostics even on observer failure.
            adb_binary=[str(art/'bin/adb'),'-s','127.0.0.1:'+str(6519+args.instance)]
            for suffix,params in [('app-exits.txt',['shell','dumpsys','activity','exit-info','org.chromium.webview_shell']),
                                  ('app-log.txt',['logcat','-d','-v','threadtime','-s','ActivityManager','StrictMode','chromium','AndroidRuntime','System.err'])]:
                try:(root/suffix).write_text(cmd(adb_binary+params,timeout=15).stdout[-200000:])
                except Exception:pass
        for proc in procs:
            proc.terminate()
            try:proc.wait(timeout=5)
            except subprocess.TimeoutExpired:proc.kill()
        if server:server.shutdown()
        if launched:
            report['stopExit']=cmd([str(art/'bin/stop_cvd')],timeout=30).returncode
            if report['stopExit']:report['status']='failed'
        save('result.json',report)
    return 0 if report['status']=='passed' else 1


if __name__=='__main__':raise SystemExit(main())

#!/usr/bin/env python3
"""One software-rendered ARM64/KVM Cuttlefish smoke attempt inside the lab container."""
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
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import xml.etree.ElementTree as ET


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--browser', action='store_true')
    parser.add_argument('--hold-seconds', type=int, default=0)
    parser.add_argument('--fixture', action='store_true')
    args = parser.parse_args()
    if not re.fullmatch(r'android-lab-cuttlefish-boot-[0-9]{8}-a[1-9][0-9]*', args.run_id):
        raise ValueError('invalid identity')
    if not 0 <= args.hold_seconds <= 900:
        raise ValueError('invalid bounded hold')
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (8192, 8192))
    folder = Path('/lab')/args.run_id
    folder.mkdir(exist_ok=False)
    artifacts = folder/'artifacts'
    subprocess.run(['cp', '--reflink=auto', '-a', '/lab/cf-a3', str(artifacts)], check=True)
    # Reclaim only our newly copied file pages before allocating guest RAM.
    for directory, _, files in os.walk(artifacts, followlinks=False):
        for name in files:
            path = Path(directory)/name
            if path.is_file() and not path.is_symlink():
                with path.open('rb', buffering=0) as stream:
                    os.posix_fadvise(stream.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
    (folder/'runtime').mkdir()
    # Retain launcher/kernel logs even if the independent guard must stop us.
    Path('/root/cuttlefish').symlink_to(folder/'runtime')
    env = dict(os.environ, ANDROID_HOST_OUT=str(artifacts), ANDROID_PRODUCT_OUT=str(artifacts))
    env['PATH'] = str(artifacts/'bin')+':'+env['PATH']
    report = {'runId': args.run_id, 'buildId': '16102939', 'androidBooted': False,
              'requestedVmManager': 'crosvm', 'requestedRenderer': 'guest_swiftshader',
              'hardwareGraphicsAccepted': False, 'startedUnix': time.time()}
    report['fileDescriptorLimit'] = list(resource.getrlimit(resource.RLIMIT_NOFILE))
    if args.fixture:
        # Modify only this new run's sample UI copy. The official package stays intact.
        jquery = Path('/lab/'+args.run_id+'.jquery.js').read_bytes()
        if hashlib.sha256(jquery).hexdigest() != 'ff1523fb7389539c84c65aba19260648793bb4f5e29329d2ee8804bc37a3fe6e':
            raise RuntimeError('unexpected official jQuery bytes')
        assets = artifacts/'usr/share/webrtc/assets'
        client = assets/'client.html'; original = client.read_bytes()
        text = original.decode().replace('https://ajax.googleapis.com/ajax/libs/jquery/3.6.0/jquery.min.js', 'jquery-3.6.0.min.js')
        text = re.sub(r'\s*<link[^>]+href="https://fonts.googleapis.com/[^>]+>', '', text)
        client.write_text(text); (assets/'jquery-3.6.0.min.js').write_bytes(jquery)
        report['sampleUiDependencyPatch'] = {'originalSha256':hashlib.sha256(original).hexdigest(),
            'patchedSha256':hashlib.sha256(client.read_bytes()).hexdigest(),
            'jquerySha256':hashlib.sha256(jquery).hexdigest(), 'externalFontRequestsRemoved':True,
            'scope':'new private run sample client only; no Android or media substitution'}
    # The companion package's unmodified capability_query is a package feature
    # declaration, NOT a hardware check. Prove actual KVM access independently.
    with open('/dev/kvm', 'rb', buffering=0) as kvm:
        report['containerKvmApi'] = fcntl.ioctl(kvm, 0xAE00, 0)
        vmfd = fcntl.ioctl(kvm, 0xAE01, 0)
        os.close(vmfd)
        report['containerEmptyVmCreated'] = True
    subprocess.run(['install', '-D', '-m', '755', '/lab/capability_query.py',
                    '/usr/lib/cuttlefish-common/bin/capability_query.py'], check=True)
    for group in ('kvm', 'cvdnetwork', 'render'):
        if subprocess.run(['getent', 'group', group], capture_output=True).returncode:
            subprocess.run(['groupadd', group], check=True)
    launch = [str(artifacts/'bin/launch_cvd'), '--daemon=true', '--report_anonymous_usage_stats=n',
              '--cpus=4', '--memory_mb=4096', '--x_res=720', '--y_res=1280', '--dpi=320',
              '--refresh_rate_hz=30',
              '--gpu_mode=guest_swiftshader', '--enable_sandbox=false', '--vm_manager=crosvm',
              '--start_webrtc=true', '--enable_tap_devices=false', '--vhost_net=false',
              '--netsim=false', '--netsim_bt=false', '--netsim_uwb=false', '--enable_modem_simulator=false',
              '--num_instances=1', '--base_instance_num=21', '--vsock_guest_cid=2121',
              '--system_image_dir='+str(artifacts)]
    report['launchArguments'] = launch
    def adb(*params, timeout=30):
        return subprocess.run([str(artifacts/'bin/adb'), *params], env=env,
                              capture_output=True, text=True, timeout=timeout)
    started = time.monotonic()
    browser_processes = []
    fixture_server = None
    try:
        with (folder/'launch.stdout').open('x') as stdout, (folder/'launch.stderr').open('x') as stderr:
            launched = subprocess.run(launch, env=env, cwd=artifacts, stdout=stdout, stderr=stderr, timeout=570)
        report['launchExitCode'] = launched.returncode
        if launched.returncode:
            raise RuntimeError('launch_cvd failed; see launch.stderr')
        report['launcherBootSeconds'] = time.monotonic()-started
        report['adbConnect'] = adb('connect', '127.0.0.1:6540').stdout
        while time.monotonic()-started < 600:
            devices = adb('devices').stdout
            serials = [line.split()[0] for line in devices.splitlines() if line.endswith('\tdevice')]
            if len(serials) == 1:
                serial = serials[0]
                if adb('-s', serial, 'shell', 'getprop', 'sys.boot_completed').stdout.strip() == '1':
                    report['androidBooted'] = True
                    report['bootSeconds'] = time.monotonic()-started
                    report['properties'] = adb('-s', serial, 'shell', 'getprop').stdout
                    report['installedPackages'] = adb('-s', serial, 'shell', 'pm', 'list', 'packages').stdout
                    report['browserActivity'] = adb('-s', serial, 'shell', 'cmd', 'package', 'resolve-activity',
                                                    '-a', 'android.intent.action.VIEW', '-d', 'http://127.0.0.1:8128/').stdout
                    report['surfaceFlinger'] = adb('-s', serial, 'shell', 'dumpsys', 'SurfaceFlinger').stdout
                    adb('-s', serial, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
                    adb('-s', serial, 'shell', 'wm', 'dismiss-keyguard')
                    adb('-s', serial, 'shell', 'input', 'swipe', '360', '1100', '360', '300', '250')
                    report['settingsLaunch'] = adb('-s', serial, 'shell', 'am', 'start', '-W',
                                                   '-a', 'android.settings.SETTINGS').stdout
                    time.sleep(2)
                    report['windowState'] = adb('-s', serial, 'shell', 'dumpsys', 'window', 'displays').stdout
                    report['settingsFocused'] = any('mCurrentFocus' in line and 'com.android.settings' in line
                                                    for line in report['windowState'].splitlines())
                    if not report['settingsFocused']:
                        raise RuntimeError('Settings is not the focused visible window')
                    subprocess.run([str(artifacts/'bin/adb'), '-s', serial, 'shell', 'screencap', '-p',
                                    '/data/local/tmp/android-lab.png'], env=env, check=True, timeout=20)
                    subprocess.run([str(artifacts/'bin/adb'), '-s', serial, 'pull',
                                    '/data/local/tmp/android-lab.png', str(folder/'settings.png')],
                                   env=env, check=True, timeout=20)
                    break
            time.sleep(5)
        if not report['androidBooted']:
            raise RuntimeError('Android boot deadline exceeded')
        apk=Path('/lab/'+args.run_id+'.calculator.apk')
        if apk.exists():
            data=apk.read_bytes()
            if len(data)!=7047681 or hashlib.sha256(data).hexdigest()!='7c5443c22d6d62c67dfe80df33ea9161ff0fa440f92590bcb45d7008b57613ed':
                raise RuntimeError('test APK mismatch')
            installed=adb('install',str(apk),timeout=60)
            if installed.returncode or 'Success' not in installed.stdout:raise RuntimeError('test APK install failed')
            activity=adb('shell','cmd','package','resolve-activity','--brief','-a','android.intent.action.MAIN',
                '-c','android.intent.category.LAUNCHER','org.fossify.math').stdout.strip().splitlines()[-1]
            if not activity.startswith('org.fossify.math/'):raise RuntimeError('unexpected app activity')
            launched_app=adb('shell','am','start','-W','-n',activity)
            time.sleep(2)
            focus=[s.strip() for s in adb('shell','dumpsys','window','displays').stdout.splitlines() if 'mCurrentFocus=' in s]
            if launched_app.returncode or 'Error' in launched_app.stdout or not any('org.fossify.math' in s for s in focus):
                raise RuntimeError('test app failed to open')
            report['testApp']={'package':'org.fossify.math','sha256':hashlib.sha256(data).hexdigest(),
                'bytes':len(data),'install':installed.stdout,'launch':launched_app.stdout,'focus':focus,
                'source':'https://github.com/FossifyOrg/Calculator/releases/tag/1.4.0',
                'scope':'installation and focused activity; not every app or integrity acceptance'}
            adb('shell','screencap','-p','/data/local/tmp/test-app.png')
            if adb('pull','/data/local/tmp/test-app.png',str(folder/'test-app.png')).returncode:raise RuntimeError('test app screenshot failed')
        if args.fixture:
            fixture = folder/'fixture'; fixture.mkdir()
            data = Path('/lab/'+args.run_id+'.fixture.html').read_bytes()
            (fixture/'index.html').write_bytes(data)
            class QuietHandler(SimpleHTTPRequestHandler):
                def log_message(self, *args): pass
            fixture_server = ThreadingHTTPServer(('127.0.0.1',8128),partial(QuietHandler,directory=str(fixture)))
            threading.Thread(target=fixture_server.serve_forever,daemon=True).start()
            if adb('reverse','tcp:8128','tcp:8128').returncode: raise RuntimeError('fixture reverse failed')
            opened = adb('shell','am','start','-W','-a','android.intent.action.VIEW','-d','http://127.0.0.1:8128/')
            report['fixtureLaunch'] = opened.stdout
            if opened.returncode or 'Error:' in opened.stdout: raise RuntimeError('fixture launch failed')
            time.sleep(3)
            pid = adb('shell','pidof','org.chromium.webview_shell').stdout.strip()
            if not pid.isdigit(): raise RuntimeError('one test WebView process required')
            if adb('forward','tcp:9223','localabstract:webview_devtools_remote_'+pid).returncode:
                raise RuntimeError('test WebView debug bridge failed')
            browser_processes.append(subprocess.Popen(['socat','TCP-LISTEN:19223,bind=0.0.0.0,reuseaddr,fork','TCP:127.0.0.1:9223'],
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
            report['fixtureSha256'] = hashlib.sha256(data).hexdigest()
            report['webViewDebugBridge'] = 'private container bridge only; SSH required; synthetic fixture only'
            geometry = adb('shell','uiautomator','dump','/data/local/tmp/cf-fixture.xml',timeout=20)
            bounds = []
            if geometry.returncode == 0:
                layout = ET.fromstring(adb('shell','cat','/data/local/tmp/cf-fixture.xml').stdout)
                bounds = [n.attrib['bounds'] for n in layout.iter('node') if n.attrib.get('class')=='android.webkit.WebView']
            (folder/'fixture-metadata.json').write_text(json.dumps({'runId':args.run_id,
                'sha256':report['fixtureSha256'],'webViewBounds':bounds,'launch':opened.stdout,
                'geometryProbe':{'exit':geometry.returncode,'stdout':geometry.stdout,'stderr':geometry.stderr},
                'alternativeMeasurement':'locate synthetic green marker in actual decoded video; never infer UI acceptance from launch'}))
        if args.browser:
            # Browser shares only this test container's network and synthetic content.
            # CDP is not published on a host/LAN port; an explicit SSH tunnel is used.
            browser_log = (folder/'browser.log').open('x')
            cert = artifacts/'usr/share/webrtc/certs/server.crt'
            public = subprocess.check_output(['openssl', 'x509', '-in', str(cert), '-pubkey', '-noout'])
            der = subprocess.run(['openssl', 'pkey', '-pubin', '-outform', 'DER'], input=public,
                                 capture_output=True, check=True).stdout
            spki = base64.b64encode(hashlib.sha256(der).digest()).decode()
            report['testBrowserSpkiPin'] = spki
            browser_processes.append(subprocess.Popen(['chromium', '--headless', '--no-sandbox',
                '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=9222',
                '--ignore-certificate-errors-spki-list='+spki,
                '--user-data-dir='+str(folder/'chrome'), 'about:blank'],
                stdout=browser_log, stderr=browser_log))
            browser_processes.append(subprocess.Popen(['socat', 'TCP-LISTEN:19222,bind=0.0.0.0,reuseaddr,fork',
                                                      'TCP:127.0.0.1:9222'],
                stdout=browser_log, stderr=browser_log))
            report['browserStarted'] = True
        (folder/'inventory.json').write_text(json.dumps({k:report.get(k) for k in
            ('runId','buildId','properties','installedPackages','browserActivity','surfaceFlinger','bootSeconds')}))
        (folder/'ready.json').write_text(json.dumps({'androidBooted': True, 'settingsFocused': True,
            'browserStarted': args.browser, 'holdSeconds': args.hold_seconds}))
        print('ANDROID_LAB_READY '+json.dumps({'runId': args.run_id, 'settingsFocused': True}), flush=True)
        deadline=time.monotonic()+args.hold_seconds
        while time.monotonic()<deadline:
            receipt=folder/'browser-completed.json'
            if receipt.exists():
                value=json.loads(receipt.read_text())
                if value.get('run')!=args.run_id or value.get('status')!='passed':raise RuntimeError('browser completion failed')
                report['browserCompletion']=value
                break
            time.sleep(min(1,max(0,deadline-time.monotonic())))
        report['status'] = 'passed'
    except Exception as exc:
        report.update(status='failed', error=str(exc))
    finally:
        if fixture_server: fixture_server.shutdown()
        for proc in browser_processes:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        report['durationSeconds'] = time.monotonic()-started
        stopped = subprocess.run([str(artifacts/'bin/stop_cvd')], env=env, cwd=artifacts,
                                 capture_output=True, text=True, timeout=30)
        report['stopExitCode'] = stopped.returncode
        with (folder/'result.json').open('x') as stream:
            json.dump(report, stream, indent=2)
        for name in ('launch.stdout', 'launch.stderr'):
            if (folder/name).exists():
                print(name+':\n'+(folder/name).read_text(errors='replace')[-18000:])
        print(json.dumps({key: value for key, value in report.items()
                          if key not in ('properties', 'surfaceFlinger', 'launchArguments')}), flush=True)
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())

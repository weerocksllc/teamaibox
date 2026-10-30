#!/usr/bin/env python3
"""Fixed, offline Cuttlefish lifecycle inside one private phone container.

No HTTP management API or arbitrary command endpoint. Node Agent supplies the
read-only run declaration and an already verified/quota-limited encrypted mount.
This program cannot allocate a host volume, format media, or select Docker flags.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import resource
import signal
import ssl
import subprocess
import threading
import time
import urllib.request

BASE = Path('/opt/cuttlefish')
DATA = Path('/phone')
CONFIG = Path('/run/phone/config.json')
CERTS = Path('/run/phone/certs')
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
VBMETA = ('vbmeta', 'vbmeta_system', 'vbmeta_system_dlkm', 'vbmeta_vendor_dlkm')


class PhoneError(RuntimeError):
    pass


def closed_json(raw):
    def pairs(values):
        result = {}
        for key, value in values:
            if key in result: raise PhoneError('phone_config_invalid')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs)


def validate_config(value):
    keys = {'version', 'phoneId', 'ownerId', 'volumeId', 'runId', 'generation', 'buildId', 'instance'}
    if not isinstance(value, dict) or set(value) != keys or type(value['version']) is not int or value['version'] != 1 or value['buildId'] != '16102939':
        raise PhoneError('phone_config_invalid')
    if any(not isinstance(value[k], str) or not UUID.fullmatch(value[k]) for k in ('phoneId', 'ownerId', 'volumeId', 'runId')):
        raise PhoneError('phone_config_invalid')
    if type(value['generation']) is not int or not 1 <= value['generation'] < 2**53 or type(value['instance']) is not int or not 21 <= value['instance'] <= 21+(65535-20049)//100:
        raise PhoneError('phone_config_invalid')
    return value


def atomic_json(path, value):
    temporary = path.with_name(path.name+'.pending')
    # Parent paths are fixed, private and not writable by the Android guest.
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(value, stream); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, path)
    descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)


def ensure_private_data(config, base=BASE, data=DATA, command=subprocess.run):
    if data.is_symlink() or not data.is_dir(): raise PhoneError('phone_storage_unavailable')
    binding = {key: config[key] for key in ('phoneId', 'ownerId', 'volumeId', 'buildId')}
    marker = data / '.phone-data.json'
    if marker.exists() or marker.is_symlink():
        if marker.is_symlink() or closed_json(marker.read_text()) != binding: raise PhoneError('phone_data_identity_mismatch')
    else:
        # The exclusive controller lock is created before initialization. No
        # prior phone data (or other unbound files) may be adopted.
        if any(path.name != '.runtime.lock' for path in data.iterdir()): raise PhoneError('phone_data_not_empty')
        atomic_json(marker, binding)
    for directory in ('home', 'cuttlefish', 'exchange', 'boot-metadata'):
        path = data/directory
        if path.is_symlink(): raise PhoneError('phone_data_identity_mismatch')
        path.mkdir(exist_ok=True, mode=0o700)
    # assemble_cvd opens these small metadata images read/write to enforce AVB
    # padding. Give it per-phone copies; the shared system/base never becomes
    # writable. No boot verification/signature is disabled or re-signed here.
    for name in VBMETA:
        original = base/(name+'.img')
        if not original.is_file() or original.stat().st_size > 65536:
            raise PhoneError('phone_base_metadata_invalid')
        expected = original.read_bytes().ljust(65536, b'\0')
        target = data/'boot-metadata'/(name+'.img')
        if target.is_symlink(): raise PhoneError('phone_data_identity_mismatch')
        if not target.exists():
            with target.open('xb') as stream: stream.write(expected); stream.flush(); os.fsync(stream.fileno())
        if target.stat().st_size != 65536 or target.read_bytes() != expected:
            raise PhoneError('phone_base_metadata_changed')
    userdata = data/'userdata.img'
    if userdata.is_symlink(): raise PhoneError('phone_data_identity_mismatch')
    if not userdata.exists():
        pending = data/'userdata.pending.img'
        if pending.is_symlink(): raise PhoneError('phone_data_identity_mismatch')
        # Only pristine fixed-build userdata, never another phone's data. Sparse
        # conversion creates holes instead of a second shared writable bottom.
        result = command([str(base/'bin/simg2img'), str(base/'userdata.img'), str(pending)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
        if result.returncode: raise PhoneError('phone_data_initialization_failed')
        with pending.open('rb') as stream: os.fsync(stream.fileno())
        os.replace(pending, userdata)
    if not userdata.is_file() or userdata.stat().st_size != 8*1024**3: raise PhoneError('phone_data_invalid')
    return binding


def launch_arguments(config, base=BASE, data=DATA, certs=CERTS):
    return [str(base/'bin/launch_cvd'), '--daemon=true', '--report_anonymous_usage_stats=n',
        '--cpus=4', '--memory_mb=4096', '--x_res=720', '--y_res=1280', '--dpi=320', '--refresh_rate_hz=30',
        '--gpu_mode=guest_swiftshader', '--enable_sandbox=false', '--vm_manager=crosvm',
        '--enable_tap_devices=false', '--vhost_net=false', '--netsim=false', '--netsim_bt=false', '--netsim_uwb=false',
        '--enable_modem_simulator=true', '--num_instances=1', '--enable_audio=true',
        '--base_instance_num='+str(config['instance']), '--vsock_guest_cid='+str(2100+config['instance']),
        '--system_image_dir='+str(base), '--instance_dir='+str(data/'cuttlefish'),
        '--data_image='+str(data/'userdata.img'), '--data_policy=use_existing', '--resume=true',
        '--start_webrtc=true', '--start_webrtc_sig_server=true', '--webrtc_sig_server_secure=true',
        '--webrtc_device_id=phone-'+config['phoneId'], '--webrtc_assets_dir='+str(base/'usr/share/webrtc/assets'),
        '--webrtc_certs_dir='+str(certs)] + [
        '--'+name+'_image='+str(data/'boot-metadata'/(name+'.img')) for name in VBMETA]


def media_device_available(devices, expected):
    # Build 16102939 returns a JSON array of IDs, not device objects. There must
    # be exactly this phone, not an unrelated/whole-node operator catalogue.
    return devices == [expected]


def guest_processes(proc=Path('/proc')):
    """Read only this container's PID namespace; do not signal by process name."""
    result=[]
    for entry in proc.iterdir():
        if not entry.name.isdecimal(): continue
        try:
            if (entry/'comm').read_text().strip() != 'crosvm': continue
            # A zombie has already exited and no longer holds the guest disk.
            state=(entry/'stat').read_text().rsplit(')',1)[1].split()[0]
            if state not in ('Z','X'): result.append(int(entry.name))
        except FileNotFoundError: continue # Process exited during observation.
    return result


def shutdown_process_summary(proc=Path('/proc')):
    # Only process role/count metadata, never guest content or full arguments.
    values=[]
    for pid in guest_processes(proc):
        try:
            argv=(proc/str(pid)/'cmdline').read_bytes().split(b'\0')
            role=next((x.decode('ascii') for x in argv[1:] if x in (b'run',b'device',b'devices')), 'other')
            fields=(proc/str(pid)/'stat').read_text().rsplit(')',1)[1].split()
            parent=int(fields[1]); parent_name=(proc/str(parent)/'comm').read_text().strip()
            sockets=[Path(x.decode('utf-8').split('=',1)[1]).name for x in argv if x.startswith(b'--socket=')]
            cids=[int(x.split(b'=',1)[1]) for x in argv if re.fullmatch(rb'--cid=[0-9]+',x)]
            values.append({'pid':pid,'role':role,'parentRole':parent_name if parent_name in ('crosvm','process_restart','run_cvd') else 'other',
                           'controlSockets':[x for x in sockets if x in ('crosvm_control.sock','ap_control.sock')], 'cids':cids})
        except FileNotFoundError: continue
    return values[:32]


def android_processes():
    # Cuttlefish also runs its OpenWrt access-point VM (ap_control.sock). It
    # must outlive Android until stop_cvd cleans the network helpers. Identify
    # Android by its own control socket, not merely by the shared crosvm name.
    return [p['pid'] for p in shutdown_process_summary() if p['role']=='run'
            and p['parentRole']=='process_restart' and p['controlSockets']==['crosvm_control.sock']]


class Runtime:
    def launch_arguments(self):
        return launch_arguments(self.config)

    def __init__(self, config):
        self.config = config
        self.stopping = threading.Event()
        self.launched = False
        self.media_control = None
        self.adb_control = None
        self.serial = '127.0.0.1:'+str(6519+config['instance'])
        self.status = {key: config[key] for key in ('phoneId', 'ownerId', 'volumeId', 'runId', 'generation', 'buildId')}
        self.status.update(phase='starting', androidReady=False, mediaReady=False, cleanShutdown=False, errorCode=None)

    def save(self):
        self.status['updatedAtUnixMs'] = int(time.time()*1000)
        atomic_json(DATA/'.phone-status.json', self.status)

    def command(self, args, timeout=10):
        return subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout, text=True)

    def adb(self, *args, timeout=10):
        return self.command([str(BASE/'bin/adb'), '-s', self.serial, *args], timeout)

    def ready(self):
        try:
            boot = self.adb('shell', 'getprop', 'sys.boot_completed', timeout=5)
            android = boot.returncode == 0 and boot.stdout.strip() == '1'
            context = ssl.create_default_context(cafile=str(CERTS/'server.crt'))
            # Loopback within this phone, pinned to the supplied private-runtime
            # certificate. No public URL, proxy environment or insecure fallback.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context))
            with opener.open('https://127.0.0.1:'+str(8443+self.config['instance']-1)+'/devices', timeout=3) as response:
                devices = json.loads(response.read(65537))
            expected = 'phone-'+self.config['phoneId']
            media = media_device_available(devices, expected)
            return android, media
        except (OSError, ValueError, subprocess.TimeoutExpired): return False, False

    def stop(self):
        clean = False
        if self.adb_control:
            try: self.adb_control.stop()
            except Exception: self.status['errorCode'] = 'phone_adb_close_unconfirmed'
        if self.media_control:
            try: self.media_control.stop()
            except Exception: self.status['errorCode'] = 'phone_media_close_unconfirmed'
        evidence={'syncCompleted':False,'androidShutdownRequested':False,'guestExitedBeforeRuntimeStop':False}
        if self.launched:
            try:
                diagnostics={'before':shutdown_process_summary()}
                self.status['shutdownDiagnostics']=diagnostics
                was_running=len(android_processes())==1
                flushed = self.adb('shell', 'sync', timeout=15).returncode == 0
                request = self.adb('shell', 'setprop', 'sys.powerctl', 'shutdown', timeout=5)
                requested = request.returncode == 0
                diagnostics['requestExitCode']=request.returncode
                diagnostics['requestReportedFailure']=any(x in request.stdout.lower() for x in ('failed','denied','error'))
                evidence.update(syncCompleted=flushed,androidShutdownRequested=requested)
                deadline = time.monotonic()+20
                while requested and time.monotonic() < deadline:
                    if not android_processes():
                        evidence['guestExitedBeforeRuntimeStop']=was_running
                        clean = flushed and was_running; break
                    time.sleep(0.5)
                diagnostics['after']=shutdown_process_summary()
            except (OSError, subprocess.TimeoutExpired): pass
            # stop_cvd and its launcher's process-group cleanup may overlap
            # after the guest has powered off. Confirm a settled, successful
            # cleanup instead of sampling the first transient return only.
            # This never substitutes for the guest's sync/shutdown proof.
            cleanup = self.cleanup_runtime()
            clean = clean and cleanup
        self.status.update(phase='stopped', androidReady=False, mediaReady=False, cleanShutdown=clean, shutdownEvidence=evidence)
        self.save()

    def cleanup_runtime(self):
        attempts = []
        self.status.setdefault('shutdownDiagnostics', {})['runtimeCleanup'] = attempts
        deadline = time.monotonic() + 30
        for number in range(3):
            remaining = deadline - time.monotonic()
            if remaining <= 0: break
            attempt = {'attempt': number + 1}
            attempts.append(attempt)
            try:
                stopped = self.command([str(BASE/'bin/stop_cvd')], timeout=min(10, remaining))
                attempt['exitCode'] = stopped.returncode
                # Only counts and exit codes; no guest contents or arguments.
                attempt['remainingGuestProcesses'] = len(guest_processes())
                if stopped.returncode == 0 and attempt['remainingGuestProcesses'] == 0:
                    return True
            except subprocess.TimeoutExpired:
                attempt['error'] = 'timeout'
            except OSError as error:
                attempt.update(error='os_error', errno=error.errno)
            if number < 2:
                time.sleep(min(.5, max(0, deadline - time.monotonic())))
        return False

    def serve(self):
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        resource.setrlimit(resource.RLIMIT_NOFILE, (8192, 8192))
        ensure_private_data(self.config)
        os.environ.update(HOME=str(DATA/'home'), ANDROID_HOST_OUT=str(BASE), ANDROID_PRODUCT_OUT=str(BASE))
        os.chdir(DATA/'home')
        for key in tuple(os.environ):
            if key.lower().endswith('_proxy'): os.environ.pop(key)
        signal.signal(signal.SIGTERM, lambda *_: self.stopping.set())
        signal.signal(signal.SIGINT, lambda *_: self.stopping.set())
        self.save()
        try:
            with open('/dev/kvm', 'rb', buffering=0) as stream:
                if fcntl.ioctl(stream, 0xAE00, 0) != 12: raise PhoneError('phone_kvm_unavailable')
            # Diagnostic output stays on this encrypted quota-limited volume.
            with (DATA/'.launch.log').open('wb') as log:
                self.launched = True
                result = subprocess.run(self.launch_arguments(), stdout=log, stderr=log, timeout=180)
            if result.returncode: raise PhoneError('phone_launch_failed')
            self.command([str(BASE/'bin/adb'), 'connect', self.serial])
            deadline = time.monotonic()+120
            while not self.stopping.is_set():
                android, media = self.ready()
                if android and media: break
                if time.monotonic() >= deadline: raise PhoneError('phone_readiness_timeout')
                self.stopping.wait(1)
            if not self.stopping.is_set():
                from phone_media_control import MediaControl
                from phone_adb_control import AdbControl
                self.adb_control = AdbControl(self.config)
                self.adb_control.start()
                self.media_control = MediaControl(self.config, adb=self.adb_control)
                self.media_control.start()
                self.status.update(phase='running', androidReady=True, mediaReady=True); self.save()
            while not self.stopping.wait(2):
                android, media = self.ready()
                if not android or not media:
                    self.status.update(phase='unavailable', androidReady=android, mediaReady=media)
                else: self.status.update(phase='running', androidReady=True, mediaReady=True)
                self.save()
        except Exception as error:
            self.status['errorCode'] = str(error) if isinstance(error, PhoneError) else 'phone_runtime_failed'
        finally: self.stop()
        return 1 if self.status['errorCode'] else 0


def main(runtime_class=Runtime):
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=('serve', 'inspect'))
    args = parser.parse_args()
    config = validate_config(closed_json(CONFIG.read_bytes()[:4097]))
    if args.action == 'inspect':
        value = closed_json((DATA/'.phone-status.json').read_bytes()[:4097])
        if any(value.get(key) != config[key] for key in ('phoneId', 'ownerId', 'volumeId', 'runId', 'generation', 'buildId')):
            raise PhoneError('phone_stale_run')
        if value.get('phase') in ('running', 'unavailable') and not 0 <= int(time.time()*1000)-value.get('updatedAtUnixMs', 0) <= 30000:
            raise PhoneError('phone_status_stale')
        print(json.dumps(value)); return 0
    lock = os.open(DATA/'.runtime.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return runtime_class(config).serve()
    finally: os.close(lock)


if __name__ == '__main__':
    try: raise SystemExit(main())
    except PhoneError as error: print(json.dumps({'errorCode': str(error)})); raise SystemExit(1)

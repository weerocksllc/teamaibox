"""Bounded container probe of runtime provisioning and paused KVM, NOT Windows acceptance."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid
import runtime

def monitor_probe(root):
    """Exercise our actual reply reader, not just the inherited QEMU probe."""
    path = root/'monitor.sock'
    child = subprocess.Popen(['qemu-system-aarch64', '-machine', 'virt-8.2,gic-version=3',
        '-accel', 'kvm', '-cpu', 'host', '-m', '128', '-S', '-nodefaults', '-display', 'none',
        '-qmp', 'unix:'+str(path)+',server=on,wait=off'], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    qmp = None
    try:
        deadline = time.monotonic()+10
        while not path.exists():
            if child.poll() is not None or time.monotonic()>deadline:
                raise RuntimeError('isolated_monitor_start_failed')
            time.sleep(.05)
        qmp = runtime.Qmp(path)
        kvm = qmp.send('query-kvm')
        assert kvm == {'enabled':True, 'present':True}
        result = qmp.send('system_powerdown')
        assert result == {} and not qmp.clean_shutdown
        rejected = False
        try:
            qmp.send('teamaibox-deliberately-invalid-probe')
        except RuntimeError as exc:
            rejected = str(exc) == 'computer_qmp_command_rejected'
        assert rejected and qmp.send('query-status')['status'] == 'prelaunch'
        return {'commandAcknowledged':True, 'rejectionDetected':True,
                'monitorStillUsable':True, 'guestShutdownClaimed':False}
    finally:
        if qmp:
            qmp.close()
        # This diskless paused process is owned solely by this probe.
        child.terminate()
        child.communicate(timeout=10)

def probe():
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        work, firmware = root/'guest', root/'firmware'
        work.mkdir()
        firmware.mkdir()
        shutil.copyfile('/usr/share/AAVMF/AAVMF_VARS.ms.fd', firmware/'VARS.fd')
        digest = 'sha256:'+hashlib.sha256((firmware/'VARS.fd').read_bytes()).hexdigest()
        c = {k: str(uuid.uuid4()) for k in ('computerId','ownerId','nodeId','volumeId','firmwareId','tpmId')}
        c.update(schemaVersion=1, runId=None, generation=0, profileId='windows-runtime-component-probe',
                 runtimeImage='sha256:'+'0'*64, firmwareCodeDigest='sha256:'+'0'*64, firmwareVarsDigest=digest,
                 mediaDigest='sha256:'+'0'*64, driverDigest='sha256:'+'0'*64,
                 resources={'vcpus':4,'memoryBytes':8*1024**3,'diskBytes':128*1024**3}, tpmPpi=True, shutdownSeconds=90)
        # Deliberately no Windows media/profile claim. All data is disposable tmpfs.
        runtime.validate_config(c)
        runtime.prepare_guest(c, work, firmware)
        before = {name: {'inode':(work/name).stat().st_ino,'bytes':(work/name).stat().st_size,
                         'digest':hashlib.sha256((work/name).read_bytes()).hexdigest()}
                  for name in ('system.qcow2','VARS.fd','identity.json')}
        runtime.prepare_guest(c, work, firmware)
        runtime.verify_storage(c, work)
        after = {name: {'inode':(work/name).stat().st_ino,'bytes':(work/name).stat().st_size,
                        'digest':hashlib.sha256((work/name).read_bytes()).hexdigest()} for name in before}
        assert before == after
        disk = json.loads(subprocess.run(['qemu-img','info','--output=json',str(work/'system.qcow2')],
                          check=True,capture_output=True,text=True).stdout)
        assert disk['virtual-size'] == c['resources']['diskBytes'] and disk['format'] == 'qcow2'
        # The inherited diskless probe opens KVM but starts a paused guest with
        # no Windows volume or network. It disposes only its own QEMU process.
        kvm = json.loads(subprocess.run(['python3','/usr/local/bin/probe-ppi'],check=True,
                         capture_output=True,text=True,timeout=45).stdout)
        assert kvm['status'] == 'passed'
        monitor = monitor_probe(root)
        return {'status':'passed','provisionReplayPreserved':before==after,'virtualDiskBytes':disk['virtual-size'],
                'actualDiskBytes':disk['actual-size'],'qemuProbe':kvm,'monitorProbe':monitor,
                'windowsBootTested':False,'productAccepted':False,'encryptedStorageTested':False}

if __name__ == '__main__':
    print(json.dumps(probe()))

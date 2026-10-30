"""Small host-operation helpers shared by single-appliance maintenance tools.

This module has no enrollment, installer, credential collection or peer registry.
It never runs a command merely by being imported.
"""
import json
import hashlib
import time
import os
import shlex
import subprocess
import tempfile
from pathlib import Path
try:
    from .appliance_target import ssh_target
except ImportError:
    from appliance_target import ssh_target

ROOT = Path(__file__).resolve().parents[1]
SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
               '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
               '-o', 'StrictHostKeyChecking=yes']

def need(condition, message):
    if not condition:
        raise RuntimeError(message)

def ssh(host, args):
    return ['ssh', *SSH_OPTIONS, ssh_target(host), shlex.join([str(value) for value in args])]

def run(host, args, *, input=None, timeout=120):
    result = subprocess.run(ssh(host, args), input=input, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, stdin=subprocess.DEVNULL if input is None else None,
                            check=False, timeout=timeout)
    need(result.returncode == 0, 'appliance command failed: ' + str(args[0]))
    return result.stdout

def snapshot(host):
    ids = run(host, ['docker', 'ps', '-q', '--no-trunc']).decode().split()
    if not ids:
        return []
    values = json.loads(run(host, ['docker', 'inspect', *ids]))
    return sorted([{'id': value['Id'], 'name': value['Name'], 'image': value['Image'],
                    'startedAt': value['State']['StartedAt'], 'running': value['State']['Running']}
                   for value in values], key=lambda value: value['id'])

def main_snapshot():
    # Preserve the two-value result used by older single-host callers, but do
    # not silently exempt an old, hard-coded test container from inspection.
    return snapshot(ssh_target()), None

def store_public(path, body):
    script = "import os,sys;p=sys.argv[1];b=sys.stdin.buffer.read(1048577);assert len(b)<=1048576;f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o444);os.write(f,b);os.fsync(f);os.close(f)"
    run(ssh_target(),
        ['python3', '-c', script, path], input=body)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def digest_bytes(value):
    return 'sha256:' + hashlib.sha256(value).hexdigest()

def canonical_digest(value):
    return digest_bytes(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                   ensure_ascii=False).encode())

def write_immutable_evidence(path, value):
    """Publish one canonical-digest evidence file atomically, never replacing it."""
    value["evidenceDigest"] = canonical_digest(value)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise FileExistsError("evidence run identity is already occupied")
    fd, temporary_name = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(value, output, ensure_ascii=False, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)

class ApplianceOperationError(RuntimeError):
    pass

class Remote:
    """Explicit single-host maintenance connection; import never connects."""
    def __init__(self, target):
        self.target = target

    def run(self, arguments, *, check=True, timeout=120):
        result = subprocess.run(ssh(self.target, arguments), cwd=ROOT, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                check=False, timeout=timeout)
        if check and result.returncode != 0:
            raise ApplianceOperationError(
                f'appliance command failed: {arguments[0]} exit={result.returncode}')
        return result

def stream_call(producer, consumer, *, json_output=True):
    # Intentionally no communicate()/capture on producer: key material flows
    # between the two SSH pipes, never through Python values, a file or report.
    first = subprocess.Popen(producer, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    second = subprocess.Popen(consumer, stdin=first.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    first.stdout.close()
    try:
        output, error = second.communicate(timeout=300)
        rc = first.wait(timeout=15)
        need(rc == 0 and second.returncode == 0, 'streamed operation failed: '+error.decode()[:180])
        return json.loads(output) if json_output else None
    finally:
        for p in (first, second):
            if p.poll() is None:
                p.kill()
                p.wait()


def install(host,path,data,mode=0o440,uid=0,gid=10001):
    code="import os,sys; p=sys.argv[1]; b=sys.stdin.buffer.read(1048577); assert len(b)<=1048576; f=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,int(sys.argv[2])); os.fchown(f,int(sys.argv[3]),int(sys.argv[4])); os.write(f,b); os.fsync(f); os.close(f)"
    run(host,['sudo','-n','python3','-c',code,path,str(mode),str(uid),str(gid)],input=data)

def bounded(test,seconds=60):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        value=test()
        if value:return value
        time.sleep(2)
    raise RuntimeError('bounded readiness timeout')

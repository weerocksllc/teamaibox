#!/usr/bin/env python3
"""Bound one exact Docker test container, with a separate stop-deadline timer."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import signal
import subprocess
import time

from android_lab_probe import GIB, command, containers, sample

LABEL = 'com.teamaibox.android-lab.run'
IDENTITY = re.compile(r'android-lab-[a-z0-9-]{1,36}-[0-9]{8}-a[1-9][0-9]*')
IMAGE = re.compile(r'sha256:[0-9a-f]{64}')
CAPABILITIES = ('CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID', 'NET_ADMIN', 'SETFCAP')
VSOCK_PROFILE_SHA = 'bde4d5209f24d3d3ed2126b9f608be96c2b37b71cea34971d237783d8ce38a09'


def inspect(cid):
    # The selected fields contain no environment or user content.
    fields = ['Id', 'Image', 'Name', 'Config.Labels', 'State.Status', 'State.ExitCode', 'State.OOMKilled', 'State.Pid',
              'HostConfig.Memory', 'HostConfig.MemorySwap', 'HostConfig.NanoCpus']
    raw = command(['docker', 'inspect', '--format', '\n'.join('{{json .'+f+'}}' for f in fields), cid])
    return dict(zip(fields, [json.loads(line) for line in raw.splitlines()]))


def owned(state, cid, run_id, image):
    return (state['Id'] == cid and state['Image'] == image
            and state['Name'] == '/'+run_id and state['Config.Labels'].get(LABEL) == run_id)


def pressure_reason(samples):
    if samples[-1]['availableBytes'] < 16*GIB:
        return 'memory-margin'
    window = [s for s in samples if s['monotonic'] >= samples[-1]['monotonic']-11]
    if len(window) < 2 or window[-1]['monotonic']-window[0]['monotonic'] < 10:
        return None
    if all(s['psiSomeAvg10'] >= 5 for s in window):
        return 'memory-pressure'
    rates = [(b['pswpout']-a['pswpout'])*4096/(b['monotonic']-a['monotonic'])
             for a, b in zip(window, window[1:])]
    if all(rate > 1024*1024 for rate in rates):
        return 'sustained-swap-out'
    return None


def cgroup_sample(state):
    pid = state.get('State.Pid', 0)
    if pid <= 0:
        return None
    try:
        group = next(line[3:] for line in Path('/proc/'+str(pid)+'/cgroup').read_text().splitlines()
                     if line.startswith('0::'))
        root = Path('/sys/fs/cgroup')/group.lstrip('/')
        return {name: (root/name).read_text().strip() for name in
                ('memory.current', 'memory.peak', 'memory.swap.current', 'memory.events', 'memory.pressure')}
    except (OSError, StopIteration):
        return None


def create_args(run_id, image, memory_gib, entrypoint, payload, devices=(), volume=None, capabilities=(), vsock_seccomp=None):
    if not IDENTITY.fullmatch(run_id) or not IMAGE.fullmatch(image):
        raise ValueError('invalid exact run/image identity')
    if memory_gib not in (1, 2, 4, 8):
        raise ValueError('invalid bounded memory limit')
    for device in devices:
        if device not in ('/dev/kvm', '/dev/net/tun', '/dev/vhost-vsock', '/dev/dri/renderD128'):
            raise ValueError('unapproved device')
    if any(cap not in CAPABILITIES for cap in capabilities):
        raise ValueError('unapproved capability')
    args = ['docker', 'create', '--name', run_id, '--label', LABEL+'='+run_id,
            '--restart', 'no', '--memory', str(memory_gib*GIB), '--memory-swap', str(memory_gib*GIB),
            '--cpus', '4', '--pids-limit', '2048', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=1']
    for device in devices:
        args += ['--device', device]
    for cap in capabilities:
        args += ['--cap-add', cap]
    if vsock_seccomp:
        if hashlib.sha256(Path(vsock_seccomp).read_bytes()).hexdigest() != VSOCK_PROFILE_SHA:
            raise ValueError('unapproved seccomp profile')
        args += ['--security-opt', 'seccomp='+str(Path(vsock_seccomp).resolve())]
    if volume:
        if not re.fullmatch(r'android-lab-[a-z0-9-]{1,60}', volume):
            raise ValueError('invalid test volume')
        # Do not let Docker create or borrow a volume implicitly.
        labels = json.loads(command(['docker', 'volume', 'inspect', '--format', '{{json .Labels}}', volume]))
        if (labels or {}).get('com.teamaibox.android-lab') != 'true':
            raise ValueError('volume is not owned by Android lab')
        args += ['--mount', 'type=volume,src='+volume+',dst=/lab']
    return args + ['--entrypoint', entrypoint, image, *payload]


def run(args):
    out = Path(args.output)
    out.mkdir(parents=True, exist_ok=False)
    if args.snapshot_tag and not re.fullmatch(r'teamaibox/android-lab-[a-z0-9-]+:[0-9]{8}-a[1-9][0-9]*', args.snapshot_tag):
        raise ValueError('invalid lab snapshot tag')
    if args.snapshot_tag:
        found = subprocess.run(['docker', 'image', 'inspect', args.snapshot_tag], capture_output=True, timeout=15)
        if found.returncode == 0:
            raise ValueError('refusing to overwrite an existing image tag')
    before = containers()
    first = sample()
    if first['availableBytes'] < (args.memory_gib+16)*GIB or first['psiSomeAvg10'] >= 1:
        raise RuntimeError('fresh admission failed')
    report = {'runId': args.run_id, 'image': args.image, 'containersBefore': before,
              'status': 'running', 'samples': [first], 'androidBooted': False}
    cid = None
    timer = args.run_id+'-deadline'
    started = time.monotonic()
    def terminate(signum, frame):
        raise RuntimeError('interrupted by signal '+str(signum))
    for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(sig, terminate)
    try:
        cid = command(create_args(args.run_id, args.image, args.memory_gib, args.entrypoint,
                                  args.command, args.device, args.volume, args.cap, args.vsock_seccomp)).strip()
        report['capabilities'] = args.cap
        report['seccompProfileSha256'] = VSOCK_PROFILE_SHA if args.vsock_seccomp else 'docker-default'
        report['containerId'] = cid
        state = inspect(cid)
        if not owned(state, cid, args.run_id, args.image):
            raise RuntimeError('created container identity mismatch')
        if (state['HostConfig.Memory'] != args.memory_gib*GIB
                or state['HostConfig.MemorySwap'] != args.memory_gib*GIB
                or state['HostConfig.NanoCpus'] != 4_000_000_000):
            raise RuntimeError('resource limit mismatch')
        command(['systemd-run', '--unit='+timer, '--on-active='+str(args.seconds)+'s',
                 '--timer-property=AccuracySec=1s', '/usr/bin/docker', 'stop', '-t', '3', cid])
        command(['docker', 'start', cid])
        next_health = time.monotonic()+15
        while True:
            state = inspect(cid)
            if state['State.Status'] != 'running':
                report['status'] = 'passed' if state['State.ExitCode'] == 0 else 'failed'
                break
            if time.monotonic()-started >= args.seconds:
                raise RuntimeError('bounded-timeout')
            report['samples'].append(sample())
            report['samples'][-1]['testCgroup'] = cgroup_sample(state)
            reason = pressure_reason(report['samples'])
            if reason:
                raise RuntimeError(reason)
            if time.monotonic() >= next_health:
                after = {c['id']: c for c in containers()}
                if any(after.get(c['id']) != c for c in before):
                    raise RuntimeError('existing-service-state-changed')
                next_health += 15
            time.sleep(1)
    except Exception as exc:
        report.update(status='failed', error=str(exc)[:1800])
    finally:
        if cid:
            try:
                state = inspect(cid)
                if not owned(state, cid, args.run_id, args.image):
                    raise RuntimeError('refusing cleanup: container identity drift')
                command(['docker', 'stop', '-t', '3', cid])
                report['containerFinal'] = inspect(cid)
                # Only test-controlled stdout; no docker Env or arbitrary host logs.
                logs = subprocess.run(['docker', 'logs', '--tail', '500', cid], capture_output=True, text=True, timeout=15)
                (out/'stdout.log').write_text(logs.stdout)
                (out/'stderr.log').write_text(logs.stderr)
                if report['status'] == 'passed' and args.snapshot_tag:
                    # No production image tags and no running process is checkpointed.
                    result = subprocess.run(['docker', 'commit', cid, args.snapshot_tag],
                                            capture_output=True, text=True, timeout=120)
                    if result.returncode:
                        raise RuntimeError('lab image snapshot failed: '+result.stderr[-1000:])
                    report['snapshotImageId'] = result.stdout.strip()
                    report['snapshotTag'] = args.snapshot_tag
                command(['docker', 'rm', cid])
                report['containerRemoved'] = True
                subprocess.run(['systemctl', 'stop', timer+'.timer'], capture_output=True, timeout=15)
            except Exception as exc:
                report.update(status='failed', cleanupError=str(exc))
        report['durationSeconds'] = time.monotonic()-started
        report['containersAfter'] = containers()
        report['existingServicesUnchanged'] = report['containersAfter'] == before
        if not report['existingServicesUnchanged']:
            report['status'] = 'failed'
        with (out/'result.json').open('x') as stream:
            json.dump(report, stream, indent=2)
        print(json.dumps({'status': report['status'], 'output': str(out), 'error': report.get('error'),
                          'existingServicesUnchanged': report['existingServicesUnchanged']}))
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--image', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--memory-gib', type=int, choices=(1, 2, 4, 8), default=8)
    parser.add_argument('--seconds', type=int, default=600)
    parser.add_argument('--entrypoint', required=True)
    parser.add_argument('--volume')
    parser.add_argument('--device', action='append', default=[])
    parser.add_argument('--cap', action='append', choices=CAPABILITIES, default=[])
    parser.add_argument('--snapshot-tag')
    parser.add_argument('--vsock-seccomp')
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.command and args.command[0] == '--':
        args.command = args.command[1:]
    if not 5 <= args.seconds <= 1800:
        parser.error('deadline must be 5..1800 seconds')
    raise SystemExit(run(args))

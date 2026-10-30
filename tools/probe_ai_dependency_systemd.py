#!/usr/bin/env python3
"""Real systemd fault test using isolated /run fixture units, never product units."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid


def run(*args, check=True):
    return subprocess.run(args, check=check, capture_output=True, text=True, timeout=15)


def main(source):
    prefix = 'teamaibox-ai-probe-' + uuid.uuid4().hex[:10]
    stage = Path(tempfile.mkdtemp(prefix=prefix + '-', dir='/run'))
    units = {k: prefix + '-' + k + '.service' for k in ('docker', 'storage', 'frontdoor', 'worker', 'old')}
    paths = [Path('/run/systemd/system') / n for n in units.values()]
    def write(key, text):
        (Path('/run/systemd/system') / units[key]).write_text(text)
    def state(key, prop):
        return run('systemctl', 'show', units[key], '-p', prop, '--value').stdout.strip()
    def wait(predicate):
        deadline = time.monotonic() + 25
        while not predicate():
            if time.monotonic() > deadline:
                raise RuntimeError('isolated_probe_timeout')
            time.sleep(.25)
    try:
        write('docker', '[Service]\nType=oneshot\nExecStart=/bin/true\nRemainAfterExit=yes\n')
        write('storage', '[Unit]\nStartLimitIntervalSec=0\n[Service]\nType=oneshot\nExecStart=/usr/bin/test -f ' + str(stage/'storage-ready') + '\nRemainAfterExit=yes\n')
        write('frontdoor', '[Service]\nType=oneshot\nExecStart=/bin/false\n')
        # Reproduce the old dependency-cancellation mechanism independently.
        write('old', '[Unit]\nRequires=' + units['frontdoor'] + '\nAfter=' + units['frontdoor'] +
              '\n[Service]\nType=oneshot\nExecStart=/usr/bin/touch ' + str(stage/'old-ran') +
              '\nRestart=on-failure\nRestartSec=1\n')
        unit = (source/'teamaibox-existing-office-workers.service').read_text()
        unit += '\n' + (source/'office-frontdoor-order.conf').read_text()
        unit += '\n' + (source/'office-independent-recovery.conf').read_text()
        for old, key in [('docker.service', 'docker'), ('teamaibox-existing-business-volumes.service', 'storage'),
                         ('teamaibox-frontdoor.service', 'frontdoor')]:
            unit = unit.replace(old, units[key])
        unit = '\n'.join(line for line in unit.splitlines() if not line.startswith(('EnvironmentFile=', 'ExecStart=')))
        unit += '\n[Service]\nRestartSec=1\nExecStart=/usr/bin/touch ' + str(stage/'worker-ran') + '\n'
        write('worker', unit)
        run('systemd-analyze', 'verify', units['worker'])
        run('systemctl', 'daemon-reload')
        old_result = run('systemctl', 'start', units['old'], check=False)
        assert old_result.returncode != 0 and not (stage/'old-ran').exists()
        run('systemctl', 'start', '--no-block', units['worker'])
        wait(lambda: int(state('worker', 'NRestarts')) >= 1)
        assert not (stage/'worker-ran').exists(), 'started_before_storage_ready'
        # Only make the prerequisite ready. Never restart/start the worker here.
        (stage/'storage-ready').touch()
        run('systemctl', 'start', units['storage'])
        wait(lambda: state('worker', 'SubState') == 'exited')
        assert (stage/'worker-ran').exists()
        assert state('frontdoor', 'ActiveState') == 'failed'
        stamp = (stage/'worker-ran').stat().st_mtime_ns
        time.sleep(3)
        assert (stage/'worker-ran').stat().st_mtime_ns == stamp
        result = dict(oldDependencyCancellationReproduced=True, storageFailureRetried=True,
                      noStartBeforeStorageReady=True, automaticallyRecovered=True,
                      failedFrontdoorDidNotBlock=True, noRerunAfterSuccess=True,
                      retries=int(state('worker', 'NRestarts')))
        print(json.dumps(result))
    finally:
        run('systemctl', 'stop', *units.values(), check=False)
        run('systemctl', 'reset-failed', *units.values(), check=False)
        for path in paths:
            path.unlink(missing_ok=True)
        run('systemctl', 'daemon-reload')
        # Only exact files created in this unique temporary directory.
        for name in ('old-ran', 'worker-ran', 'storage-ready'):
            (stage/name).unlink(missing_ok=True)
        stage.rmdir()


if __name__ == '__main__':
    main(Path(sys.argv[1]))

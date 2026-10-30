"""Read a consistent live-container memory sample; never mutate Docker."""
import json
from pathlib import Path
import time


def memory_row(container):
    pid = container['State']['Pid']
    rel = next(s.split(':', 2)[2] for s in Path(f'/proc/{pid}/cgroup').read_text().splitlines() if s.startswith('0::'))
    root = Path('/sys/fs/cgroup') / rel.lstrip('/')
    stat = dict((k, int(v)) for k, v in (s.split() for s in (root / 'memory.stat').read_text().splitlines()))
    events = dict((k, int(v)) for k, v in (s.split() for s in (root / 'memory.events').read_text().splitlines()))
    return dict(id=container['Id'], name=container['Name'].lstrip('/'), current=int((root / 'memory.current').read_text()),
                peak=int((root / 'memory.peak').read_text()), anon=stat.get('anon', 0), shmem=stat.get('shmem', 0),
                inactiveFile=stat.get('inactive_file', 0),
                oomKilled=container['State']['OOMKilled'], oomKill=events.get('oom_kill', 0))


def container_memory_rows(command, read_row=memory_row, sleep=time.sleep):
    for attempt in range(3):
        ids = command(['docker', 'ps', '-q', '--no-trunc']).split()
        if not ids: return []
        containers = json.loads(command(['docker', 'inspect', *ids]))
        try:
            # Docker reports Restarting as Running=true, Pid=0. It owns no live
            # process yet; reservations remain charged by the caller regardless.
            return [read_row(c) for c in containers if c['State']['Running']
                    and not c['State'].get('Restarting') and c['State']['Pid'] > 0]
        except FileNotFoundError:
            # A live process exited between inspection and cgroup reads. Resample
            # the entire set, rather than returning a partially undercounted set.
            if attempt == 2: raise RuntimeError('boot_resource_snapshot_unstable') from None
            sleep(0.1)

#!/usr/bin/env python3
"""Independent boot recovery; never roll back healthy peers or guest data."""
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import restore_calibrated_office_workers as base


def public_error(error):
    message = str(error)
    if re.fullmatch(r'[a-z][a-z0-9_]{2,100}', message): return message
    if isinstance(error, FileNotFoundError): return 'boot_resource_file_unavailable'
    if isinstance(error, PermissionError): return 'boot_resource_permission_denied'
    try:
        code = json.loads(message).get('code')
        if isinstance(code, str) and re.fullmatch(r'[a-z][a-z0-9_]{2,100}', code): return code
    except (ValueError, AttributeError): pass
    return 'service_recovery_error'


class BootProgress:
    def __init__(self, node_id, path):
        self.node_id, self.path = node_id, Path(path)
        self.previous = None

    def __call__(self, workers, complete=False):
        value = dict(schemaVersion=1, nodeId=self.node_id, status='ready' if complete else 'recovering',
                     updatedAt=datetime.now(timezone.utc).isoformat(), workers=workers)
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        temporary = self.path.with_suffix('.new')
        with temporary.open('w') as stream:
            os.fchmod(stream.fileno(), 0o644)
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, self.path)
        summary = [(worker, info['phase'], info.get('error')) for worker, info in workers.items()]
        if summary != self.previous:
            print(json.dumps(value), flush=True)
            self.previous = summary


def recover(value, entries, adapter, progress=lambda *_args, **_kwargs: None,
            health_timeout=900, retry_initial=5, retry_max=60):
    workers = {p['workerId']: dict(phase='queued', attempts=0) for p in value['models']}
    ids = {p['containerId']: p['workerId'] for p in value['models']}
    due, restart, started = {}, set(), []

    def emit(entry, phase, **fields):
        info = workers[ids[entry['id']]]
        info.update(phase=phase, **fields)
        if phase == 'ready':
            info.pop('error', None)
        progress(workers)

    def missing():
        # Partial allocation already consumes MemAvailable; do not charge it twice.
        return {e['id'] for e in entries if not adapter.inspect(e)['running']}

    while True:
        for entry in entries:
            cid = entry['id']
            try:
                current = adapter.inspect(entry)
                if current['healthy'] and current['running']:
                    restart.discard(cid)
                    emit(entry, 'ready')
                    continue
                if adapter.monotonic() < due.get(cid, 0):
                    continue
                emit(entry, 'waiting')
                adapter.wait_ready(False)
                base.observe(value, adapter.snapshot(value), missing())
                current = adapter.inspect(entry)
                if cid in restart and current['running'] and not current['healthy']:
                    adapter.stop(entry)  # Only this timed-out model, never its peers.
                    current = adapter.inspect(entry)
                restart.discard(cid)
                if not current['running']:
                    adapter.start(entry)
                    started.append(cid)
                if hasattr(adapter, 'retain_gpu_access'):
                    adapter.retain_gpu_access(entry)
                emit(entry, 'loading')
                deadline = adapter.monotonic() + health_timeout
                while True:
                    current = adapter.inspect(entry)
                    base.need(current['running'] and not current['oomKilled'], 'office_worker_failed_during_boot')
                    if current['healthy']:
                        emit(entry, 'ready')
                        break
                    if adapter.monotonic() >= deadline:
                        restart.add(cid)
                        raise RuntimeError('office_worker_health_timeout')
                    base.observe(value, adapter.snapshot(value), missing())
                    progress(workers)
                    adapter.sleep(min(3, max(0, deadline - adapter.monotonic())))
            except Exception as error:
                info = workers[ids[cid]]
                attempts = info['attempts'] + 1
                delay = min(retry_max, retry_initial * 2 ** min(attempts - 1, 10))
                due[cid] = adapter.monotonic() + delay
                emit(entry, 'retrying', attempts=attempts, retryAfterSeconds=delay, error=public_error(error))
        if all(info['phase'] == 'ready' for info in workers.values()):
            # A peer may exit while a later model loads. Do not publish a stale all-ready result.
            for entry in entries:
                try:
                    current = adapter.inspect(entry)
                    if not (current['healthy'] and current['running']): emit(entry, 'queued')
                except Exception as error:
                    emit(entry, 'retrying', error=public_error(error))
            if all(info['phase'] == 'ready' for info in workers.values()):
                progress(workers, complete=True)
                return dict(status='passed', officeSetHealthy=True, count=len(entries),
                            startedIds=list(dict.fromkeys(started)), workers=workers)
        progress(workers)
        next_due = [max(0, at - adapter.monotonic()) for cid, at in due.items()
                    if workers[ids[cid]]['phase'] != 'ready']
        adapter.sleep(max(1, min([5, *next_due])))

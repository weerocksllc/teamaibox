"""Identify Android under its camera supervisor during graceful shutdown."""
from pathlib import Path
import phone_runtime_base as base


def android_processes(proc=Path('/proc')):
    result = []
    for p in base.shutdown_process_summary():
        if p['role'] != 'run' or p['controlSockets'] != ['crosvm_control.sock']:
            continue
        if p['parentRole'] == 'process_restart':
            result.append(p['pid'])
            continue
        # Read only this container's proc namespace. Never identify a target
        # merely by its generic Python process name.
        try:
            fields = (proc / str(p['pid']) / 'stat').read_text().rsplit(')', 1)[1].split()
            args = (proc / fields[1] / 'cmdline').read_bytes().split(b'\0')
            if len(args) > 2 and args[1] == b'/opt/teamaibox/phone_camera_crosvm.py' and b'run' in args[2:]:
                result.append(p['pid'])
        except FileNotFoundError:
            continue
    return result


base.android_processes = android_processes
# Preserve the existing network/camera Runtime subclasses and entry points.
from phone_runtime_base import *

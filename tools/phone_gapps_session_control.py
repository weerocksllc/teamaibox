"""Local, bounded test-session control; commands never contain credentials."""
import json
import os
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path
from appliance_operations import ROOT, need

EVIDENCE = ROOT / 'evidence/validation/virtual-phones'


def directory(run_id):
    need(re.fullmatch(r'phone-gapps-interactive-\d{8}-a[1-9]\d*', run_id), 'invalid_run')
    return EVIDENCE / (run_id + '-session')


def validate_command(text):
    need(text in ('reboot', 'finish', 'stop') or re.fullmatch(r'sample [a-z][a-z0-9-]{0,30}', text), 'invalid_command')
    return text


def write_status(root, value):
    temporary = root / 'status.tmp'
    with temporary.open('w') as f:
        json.dump(value, f)
    temporary.replace(root / 'status.json')


def detach(script, run_id, minutes):
    root = directory(run_id)
    need(not (EVIDENCE / (run_id + '.json')).exists(), 'run_occupied')
    root.mkdir(mode=0o700)
    (root / 'commands').mkdir(mode=0o700)
    with (root / 'controller.log').open('x') as log:
        child = subprocess.Popen([sys.executable, str(script), '--run-id', run_id, '--minutes', str(minutes)],
                                 cwd=ROOT, stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                 start_new_session=True, close_fds=True)
    with (root / 'controller.json').open('x') as f:
        json.dump({'pid': child.pid, 'runId': run_id, 'script': str(script), 'createdAtUnix': time.time()}, f)
    return {'pid': child.pid, 'runId': run_id, 'session': str(root.relative_to(ROOT))}


def send(run_id, text):
    validate_command(text)
    root = directory(run_id)
    need(root.is_dir() and not root.is_symlink(), 'session_missing')
    status = json.loads((root / 'status.json').read_text())
    need(status['runId'] == run_id and status['phase'] == 'ready' and status['expiresAtUnix'] > time.time(), 'session_not_ready')
    key = str(time.time_ns()) + '-' + uuid.uuid4().hex
    with (root / 'commands' / (key + '.tmp')).open('x') as f:
        json.dump({'runId': run_id, 'command': text}, f)
    (root / 'commands' / (key + '.tmp')).rename(root / 'commands' / (key + '.json'))
    return {'runId': run_id, 'commandId': key}


def next_command(root, run_id, processed):
    for path in sorted((root / 'commands').glob('*.json')):
        if path.name in processed:
            continue
        need(not path.is_symlink() and path.stat().st_size < 256, 'invalid_command_file')
        value = json.loads(path.read_text())
        need(value['runId'] == run_id, 'command_identity_changed')
        text = validate_command(value['command'])
        processed.append(path.name)
        return text
    return None

#!/usr/bin/env python3
"""Read state transitions for an existing receiver; never start/stop it."""
import argparse
import json
import re
import subprocess
import ssl
import sys
import termios
import time
from pathlib import Path
from datetime import datetime, timezone
from probe_current_casting_controls import Client, SSH, CA

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--session-id', required=True)
p.add_argument('--output', required=True)
a = p.parse_args()
assert re.fullmatch(r'[a-f0-9-]{36}', a.session_id)
path = Path(a.output)
assert not path.exists()
started = datetime.now(timezone.utc).isoformat()
tty = termios.tcgetattr(sys.stdin) if sys.stdin.isatty() else None
if tty:
    hidden=list(tty);hidden[3]&=~termios.ECHO;termios.tcsetattr(sys.stdin,termios.TCSANOW,hidden)
print('Waiting for test login on stdin',flush=True)
try:
    credentials=json.loads(sys.stdin.readline())
finally:
    if tty:termios.tcsetattr(sys.stdin,termios.TCSANOW,tty)
context=ssl.create_default_context(cadata=subprocess.check_output([*SSH,'sudo -n cat '+CA],timeout=15).decode())
client=Client(context)
observations=[]
error=None
try:
    client.login(credentials.pop('loginName'),credentials.pop('password'))
    last=None;sawStop=False
    for _ in range(180):
        value=client.ok('/api/v1/casting/sessions/'+a.session_id)
        # Session lifetime stays streaming when the phone stops. Only the
        # authenticated live sourceState describes sender connectivity.
        row={k:value.get(k) for k in ['id','state','sourceState','sourceStateRevision','outputHealth']}
        if row!=last:
            observations.append(dict(observedAt=datetime.now(timezone.utc).isoformat(),**row))
            print(json.dumps(observations[-1]),flush=True);last=row
        if row['sourceState']=='disconnected':sawStop=True
        if sawStop and row['sourceState']=='connected':break
        if row['state'] in ('stopped','expired','failed'):break
        time.sleep(1)
except Exception:
    error='source_observation_failed'
finally:
    client.opener.close()  # Never sign out the receiver owner.
    report=dict(startedAt=started,completedAt=datetime.now(timezone.utc).isoformat(),sessionId=a.session_id,
        observations=observations,readOnly=True,userActionConfirmationRequired=True,
        productAcceptance=False,error=error,adminSignedOut=False)
    with path.open('x') as output:json.dump(report,output,indent=2)
raise SystemExit(1 if error else 0)

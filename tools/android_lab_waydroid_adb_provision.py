#!/usr/bin/env python3
"""Provision one fresh lab public key in the owned Android; retain ADB authentication."""
import json
from pathlib import Path
import shlex
import subprocess
import time

def run(args,check=True):
    return subprocess.run(args,capture_output=True,text=True,timeout=20,check=check)

if run(['hostname']).stdout.strip()!='android-lab':raise RuntimeError('private VM only')
key=Path('/home/lab/.android/adbkey.pub').read_text().strip()
if len(key.split())!=2 or not 600<len(key)<1000:raise RuntimeError('unexpected lab public key')
shell=['sudo','waydroid','shell','--']
secure=run([*shell,'getprop','ro.adb.secure']).stdout.strip()
if secure!='1':raise RuntimeError('expected ADB authentication enabled')
# A freshly initialized test instance must not already contain authorized keys.
# Only the PUBLIC key is provisioned, just like the private Linux VM SSH setup.
script='''set -e
test ! -s /data/misc/adb/adb_keys
mkdir -p /data/misc/adb
printf '%s\\n' KEY > /data/misc/adb/adb_keys
chown 1000:2000 /data/misc/adb/adb_keys
chmod 0640 /data/misc/adb/adb_keys
restorecon /data/misc/adb/adb_keys
setprop ctl.restart adbd
'''.replace('KEY',shlex.quote(key))
run([*shell,'sh','-c',script])
run(['adb','disconnect'],check=False)
for _ in range(10):
    time.sleep(1)
    run(['waydroid','adb','connect'],check=False)
    state=run(['adb','get-state'],check=False)
    if state.returncode==0 and state.stdout.strip()=='device':
        if run([*shell,'getprop','ro.adb.secure']).stdout.strip()!='1':raise RuntimeError('authentication drift')
        print(json.dumps({'labAdbKeyApproved':True,'method':'fresh owned Android public-key provisioning',
                          'authenticationDisabled':False,'privateKeyCopiedToAndroid':False}))
        raise SystemExit(0)
raise RuntimeError('provisioned public key was not accepted')

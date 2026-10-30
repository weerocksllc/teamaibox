#!/usr/bin/env python3
"""Approve only this disposable VM's freshly-generated ADB key in its Android UI."""
import base64
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
import xml.etree.ElementTree as ET

def run(args):
    return subprocess.run(args,capture_output=True,text=True,timeout=20,check=True).stdout

if run(['hostname']).strip()!='android-lab':raise RuntimeError('private VM only')
key=Path('/home/lab/.android/adbkey.pub').read_text().split()[0]
digest=hashlib.md5(base64.b64decode(key)).hexdigest().upper()
fingerprint=':'.join(digest[i:i+2] for i in range(0,len(digest),2))
shell=['sudo','waydroid','shell','--']
for attempt in range(8):
    run([*shell,'uiautomator','dump','/sdcard/android-lab-adb-dialog.xml'])
    xml=run([*shell,'cat','/sdcard/android-lab-adb-dialog.xml'])
    tree=ET.fromstring(xml)
    text=' '.join(n.get('text','') for n in tree.iter('node'))
    if 'Allow USB debugging?' in text and fingerprint in text.upper():
        candidates=[n for n in tree.iter('node') if n.get('resource-id')=='android:id/button1'
                    and n.get('text','').lower()=='allow' and n.get('package')=='com.android.systemui']
        if len(candidates)!=1:raise RuntimeError('ambiguous ADB confirmation button')
        bounds=re.fullmatch(r'\[(\d+),(\d+)\]\[(\d+),(\d+)\]',candidates[0].get('bounds',''))
        if not bounds:raise RuntimeError('invalid confirmation bounds')
        x1,y1,x2,y2=map(int,bounds.groups())
        run([*shell,'input','tap',str((x1+x2)//2),str((y1+y2)//2)])
        for _ in range(10):
            state=subprocess.run(['adb','get-state'],capture_output=True,text=True,timeout=5)
            if state.returncode==0 and state.stdout.strip()=='device':
                print(json.dumps({'labAdbKeyApproved':True,'method':'Android confirmation UI',
                                  'fingerprintMatched':True,'authenticationDisabled':False}))
                raise SystemExit(0)
            time.sleep(1)
        raise RuntimeError('ADB did not become authorized')
    time.sleep(2)
raise RuntimeError('matching ADB confirmation was not visible; no authorization bypass performed')

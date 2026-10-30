#!/usr/bin/env python3
"""Synthetic real Android file/APK checks, executed inside a new test phone.

Invokes the fixed worker's actual framed stdin/stdout API. No member data,
network, GMS, extra permission, or public ADB listener is involved.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid

sys.path.insert(0,'/opt/teamaibox')
from phone_files import END

config=json.loads(Path('/run/phone/config.json').read_bytes())
base={k:config[k] for k in ('phoneId','ownerId','runId','generation')}
content=b'synthetic-phone-transfer-v1\x00\xff'*4096
digest=hashlib.sha256(content).hexdigest()
filename='office-probe.txt'
worker=['/usr/bin/python3','/opt/teamaibox/phone_files.py']


def call(action, *, data=b'', name=filename, change=None, suffix=END):
    job=base|{'action':action,'transferId':str(uuid.uuid4()),'deadline':int(time.time()*1000)+60000}
    if action!='list':job['name']=name
    if action in ('install','upload'):job.update(sizeBytes=len(data),sha256=hashlib.sha256(data).hexdigest())
    job.update(change or {})
    payload=json.dumps(job).encode()+b'\n'+(data+suffix if action in ('install','upload') else b'')
    result=subprocess.run(worker,input=payload,capture_output=True,timeout=65)
    line,separator,tail=result.stdout.partition(b'\n')
    assert separator,'worker_response_missing'
    value=json.loads(line)
    if result.returncode==0:
        assert all(value[k]==config[k] for k in ('phoneId','runId','generation')),'response_run_changed'
        assert value['transferId']==job['transferId'],'response_operation_changed'
    return result.returncode,value,tail


def denied(action, code, **kwargs):
    exit_code,value,_=call(action,**kwargs)
    assert exit_code!=0 and value=={'errorCode':code},'invalid_request_not_denied:'+action


def adb(*args):
    result=subprocess.run(['/opt/cuttlefish/bin/adb','-s','127.0.0.1:'+str(6519+config['instance']),*args],capture_output=True,timeout=15)
    assert result.returncode==0,'fixed_android_check_failed'
    return result.stdout


denied('upload','phone_stale_run',data=content,change={'ownerId':str(uuid.uuid4())})
denied('upload','phone_input_invalid',data=content,name='../outside.txt')
denied('upload','phone_upload_too_large',data=b'x',change={'sizeBytes':256*1024**2+1})
denied('upload','phone_object_invalid',data=content,change={'sha256':'0'*64})
denied('upload','phone_object_invalid',data=content,suffix=b'')
denied('upload','phone_object_invalid',data=content,suffix=END+b'extra')
denied('upload','phone_grant_invalid',data=content,change={'deadline':0})

if config['generation']==1:
    status,value,_=call('upload',data=content)
    assert status==0 and value['stored'] is True and value['sha256']==digest,'real_upload_failed:'+str(value)
    denied('upload','phone_object_invalid',data=content)  # No unconfirmed overwrite.

status,value,tail=call('download')
if status!=0:
    # Only fixed synthetic-file path diagnostics, never a user's directory.
    diagnostic=adb('shell','-T', 'cd /sdcard/Download/TeamAIBox; exec 3<office-probe.txt; printf "cwd="; pwd -P; printf "fd="; readlink -f /proc/self/fd/3; printf "shellfd="; readlink -f /proc/$$/fd/3; stat -Lc "%d:%i" . office-probe.txt /proc/$$/fd/3')
    print('synthetic_download_path_diagnostic:'+diagnostic[:2000].decode('utf-8','replace'),file=sys.stderr)
assert status==0 and value['sha256']==digest and value['sizeBytes']==len(content),'real_download_metadata_failed:'+str(value)
assert tail==content+END,'real_download_bytes_failed'
status,value,_=call('list')
assert status==0 and {'name':filename,'sizeBytes':len(content)} in value['files'],'real_file_list_failed'

apk=Path('/run/phone-test.apk').read_bytes()
if config['generation']==1:
    denied('install','phone_install_failed',data=b'not an APK',name='invalid.apk')
    status,value,_=call('install',data=apk,name='phone-fixture.apk')
    if status!=0:
        diagnostic=subprocess.run(['/opt/cuttlefish/bin/adb','-s','127.0.0.1:'+str(6519+config['instance']),'shell','-T',
            'cmd package install -r -S '+str(len(apk))+' -- -'],input=apk,capture_output=True,timeout=20)
        print('synthetic_apk_install_diagnostic:'+str(diagnostic.returncode)+':'+(diagnostic.stdout+diagnostic.stderr)[:2000].decode('utf-8','replace'),file=sys.stderr)
    assert status==0 and value['installed'] is True,'real_apk_install_failed:'+str(value)

assert b'package:' in adb('shell','pm','path','com.teamaibox.phonefixture'),'apk_not_retained'
adb('shell','am','start','-W','-n','com.teamaibox.phonefixture/.MainActivity')
until=time.monotonic()+5
while True:
    result=subprocess.run(['/opt/cuttlefish/bin/adb','-s','127.0.0.1:'+str(6519+config['instance']),
        'shell','run-as','com.teamaibox.phonefixture','cat','files/proof.txt'],capture_output=True,timeout=5)
    if result.returncode==0 and result.stdout.strip()==b'synthetic-phone-app-data-v1':break
    assert time.monotonic()<until,'app_data_write_not_confirmed'
    time.sleep(.2)
assert [p.name for p in Path('/phone/exchange').glob('transfer-*')]==[],'transfer_plaintext_not_cleaned'
print(json.dumps(dict(realFramedWorker=True,uploadDownloadSHA256=digest,bytes=len(content),fileListed=True,
    ownerPathDigestSizeRejected=True,extraTruncatedBytesRejected=True,expiredRequestRejected=True,
    apkInstalled=True,apkSha256=hashlib.sha256(apk).hexdigest(),appDataRetained=True,
    generation=config['generation'],temporaryDataCleaned=True,publicAPIValidated=False)))

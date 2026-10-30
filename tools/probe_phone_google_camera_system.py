"""Numeric, account-free guest checks; camera tests are separate in the same run."""
import json,os,re,subprocess
from pathlib import Path

c=json.loads(Path('/run/phone/config.json').read_bytes())
assert os.getuid()==10001 and c['instance']==21,'owned_test_instance_required'
adb=['/opt/cuttlefish/bin/adb','-s','127.0.0.1:6540']
def cmd(*args):
    p=subprocess.run(adb+list(args),capture_output=True,timeout=20)
    assert p.returncode==0,'guest_check_failed'
    return p.stdout.decode(errors='replace')
packages={p:('package:'+p) in cmd('shell','pm','list','packages',p).splitlines()
          for p in ('com.android.vending','com.google.android.gms','com.google.android.gsf')}
account_text=cmd('shell','dumpsys','account')
counts=re.findall(r'^\s*Accounts: (\d+)\s*$',account_text,re.M)
assert counts,'account_summary_missing'
count=sum(map(int,counts));account_text=None
assert count==0 and all(packages.values()),'wrong_or_private_system'
selinux=cmd('shell','getenforce').strip();assert selinux=='Enforcing','selinux_changed'
try:
    launch=cmd('shell','am','start','-W','-a','android.intent.action.MAIN','-c','android.intent.category.LAUNCHER','-p','com.android.vending')
    assert 'Status: ok' in launch,'play_launch_failed'
finally:cmd('shell','am','force-stop','com.android.vending')
print(json.dumps(dict(status='passed',packages=packages,accountCount=count,selinux=selinux,
    playLaunch=True,googleLoginTested=False,memberEnabled=False,privateContentSaved=False)),flush=True)

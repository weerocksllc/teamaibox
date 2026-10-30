#!/usr/bin/env python3
"""Resume only this appliance's installed phone control services after boot.

A per-boot acknowledgement prevents undoing an administrator's manual stop.
The local pool helper reads its key from this appliance's encrypted key store.
No SSH, key export, guest start, Docker create, format, force stop, unmount or
key creation exists in this recovery command.
"""
import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import socket
import stat
import subprocess
import sys
import time
import uuid


def need(ok, code):
    if not ok:raise RuntimeError(code)


def execute(args, timeout=30):
    p=subprocess.run(args,stdin=subprocess.DEVNULL,capture_output=True,timeout=timeout)
    need(p.returncode==0,'boot_command_failed')
    return p.stdout


def read_private(path, maximum=131072):
    path=Path(path)
    need(path.is_absolute() and str(path)==os.path.normpath(path),'invalid_path')
    for parent in (path,*path.parents):
        st=parent.lstat()
        need(not stat.S_ISLNK(st.st_mode) and st.st_uid==0 and not st.st_mode&0o022,'untrusted_path')
    st=path.stat();need(stat.S_ISREG(st.st_mode) and st.st_nlink==1 and st.st_size<=maximum,'untrusted_file')
    return path.read_bytes()


def validate_plan(p, path):
    need(p.get('version') == 2 and not {'nodeHost', 'primaryHost', 'sshTarget'} & set(p),
         'local_plan_required')
    need(re.fullmatch(r'phone-boot-services-\d{8}-a[1-9][0-9]*', p['runId']), 'invalid_plan')
    need(str(uuid.UUID(p['poolId'])) == p['poolId'] and
         re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,252}', p['applianceHostname']), 'wrong_appliance')
    need(p['stage'] == '/var/lib/teamaibox-'+p['runId'] and str(path) == p['stage']+'/plan.json',
         'wrong_stage')
    need(p['root'] == '/srv/teamaibox/phone-pools/'+p['poolId'] and
         re.fullmatch('[a-f0-9]{64}', p['agent']['id']) and
         re.fullmatch('sha256:[a-f0-9]{64}', p['agent']['image']), 'wrong_target')
    socket_root = Path(p['socketDirectory'])
    need(socket_root.is_absolute() and str(socket_root) == os.path.normpath(socket_root)
         and socket_root.parent == Path('/run') and socket_root.name.startswith('teamaibox-phone-')
         and re.fullmatch(r'teamaibox-phone-[a-z0-9-]+\.service', p['storageUnit']), 'wrong_helper')
    return p


def load_plan(path):
    return validate_plan(json.loads(read_private(path)), path)


def verify_files(files):
    for path,digest in files.items():
        need(hashlib.sha256(read_private(path,64*1024**2)).hexdigest()==digest,'installed_file_changed')


def current_boot():
    value=Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    need(str(uuid.UUID(value))==value,'boot_id_invalid');return value


def boot_needed(ack, boot):
    need(set(ack)=={'version','completedBootId'} and ack['version']==1 and
         str(uuid.UUID(ack['completedBootId']))==ack['completedBootId'],'boot_ack_invalid')
    return ack['completedBootId']!=boot


def pool_module(p):
    verify_files(p['poolFiles'])
    spec=importlib.util.spec_from_file_location('retained_phone_pool',p['poolHelper'])
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    plan=module.plan_read(Path(p['poolPlan']))
    need(plan['poolId']==p['poolId'] and plan['appliance']['hostname']==p['applianceHostname'], 'local_pool_mismatch')
    return module,plan


def agent_info(p):
    value=json.loads(execute(['docker','inspect',p['agent']['id']]))[0]
    expected=p['agent']
    need(value['Id']==expected['id'] and value['Image']==expected['image'] and
         value['Config']['User']==expected['user'] and
         canonical_mounts(value['Mounts'],'Destination')==canonical_mounts(expected['mounts'],'Destination'),'agent_identity_changed')
    for key,expected_value in expected['hostConfig'].items():
        actual=value['HostConfig'][key]
        if key=='Mounts':
            actual=canonical_mounts(actual,'Target');expected_value=canonical_mounts(expected_value,'Target')
        need(actual==expected_value,'agent_recipe_changed')
    return value


def canonical_mounts(mounts,target):
    # Docker rebuilds its map iteration order after daemon/host restart. Order
    # is not a permission; retain exact field equality and reject duplicates.
    need(isinstance(mounts,list) and all(isinstance(m,dict) and isinstance(m.get(target),str) for m in mounts),
         'invalid_mount_list')
    need(len({m[target] for m in mounts})==len(mounts),'duplicate_mount')
    return sorted(mounts,key=lambda m:m[target])


def active_phones():
    raw=execute(['docker','ps','--format','{{.Names}}']).decode().splitlines()
    return [name for name in raw if re.fullmatch(r'teamaibox-phone-[a-f0-9-]{36}',name)]


def status(p):
    need(socket.gethostname()==p['applianceHostname'],'wrong_appliance')
    ack=json.loads(read_private(p['stage']+'/ack.json',512));boot=current_boot()
    if not boot_needed(ack,boot):
        return dict(status='already-current',bootId=boot)
    # Do not undo an owner's actions or stop an active guest to recover a pool.
    need(not active_phones(),'active_phone_requires_maintenance')
    agent_info(p);verify_files(p['nodeFiles'])
    module,plan=pool_module(p)
    mapped=os.path.lexists('/dev/mapper/teamaibox-phone-'+p['poolId'])
    mounted=os.path.ismount(p['root'])
    if mapped or mounted:
        info=module.inspect_pool(plan)
        need(info['luksUUID']==p['luksUUID'] and info['filesystemUUID']==p['filesystemUUID'],'pool_identity_changed')
        state='open'
    else:
        # reopen rechecks backing inode/device/LUKS and refuses any nonempty mount.
        state='locked'
    return dict(status='pending',bootId=boot,poolState=state)


def save_ack(p,boot):
    path=Path(p['stage'])/'ack.json';temp=path.with_name('ack.pending')
    if temp.exists():
        # An interrupted fsync can leave this exact, content-free control file.
        # Validate ownership/type/size before discarding it; never touch guest data.
        read_private(temp,512)
        temp.unlink()
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as f:
        json.dump(dict(version=1,completedBootId=boot),f);f.flush();os.fsync(f.fileno())
    os.replace(temp,path)
    fd=os.open(p['stage'],os.O_RDONLY|os.O_DIRECTORY)
    try:os.fsync(fd)
    finally:os.close(fd)


def create_socket_directory(root):
    if not root.exists():
        root.mkdir(mode=0o750)
        # main() deliberately uses umask 077. mkdir(mode=0750) alone becomes
        # 0700, preventing the unprivileged Agent from traversing this directory.
        os.chmod(root,0o750,follow_symlinks=False)
        os.chown(root,0,10001)


def resume(p):
    observed=status(p)
    if observed['status']=='already-current':return observed
    module,plan=pool_module(p)
    if observed['poolState']=='locked':
        need(not agent_info(p)['State']['Running'],'agent_running_without_pool')
        # Same per-pool lock as the retained one-shot maintenance tool.
        lock=os.open('/run/lock/teamaibox-phone-pool-'+p['poolId'],os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            module.reopen(plan)  # Reads this appliance's existing key; no new key or disk.
        finally:os.close(lock)
    need(not active_phones(),'phone_became_active')
    verify_files(p['encryptedFiles'])
    root=Path(p['socketDirectory'])
    create_socket_directory(root)
    s=root.lstat();need(stat.S_ISDIR(s.st_mode) and (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(0,10001,0o750),'socket_directory_changed')
    execute(['systemctl','start',p['storageUnit']])
    socket_path=root/'storage.sock';deadline=time.monotonic()+20
    while not socket_path.exists() and time.monotonic()<deadline:time.sleep(.5)
    s=socket_path.lstat();need(stat.S_ISSOCK(s.st_mode) and (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))==(0,10001,0o660),'storage_not_ready')
    current=agent_info(p)
    if not current['State']['Running']:execute(['docker','start',p['agent']['id']])
    deadline=time.monotonic()+65
    while time.monotonic()<deadline:
        if agent_info(p)['State'].get('Health',{}).get('Status')=='healthy':break
        time.sleep(2)
    else:raise RuntimeError('agent_not_healthy')
    need(current_boot()==observed['bootId'] and not active_phones(),'unexpected_phone_or_boot_change')
    save_ack(p,observed['bootId'])
    return dict(status='restored',bootId=observed['bootId'],phonesStarted=False)


def main():
    resource.setrlimit(resource.RLIMIT_CORE,(0,0));os.umask(0o077)
    ap=argparse.ArgumentParser();ap.add_argument('--plan',required=True)
    ap.add_argument('action',choices=('check','resume'));a=ap.parse_args()
    need(os.geteuid()==0,'root_required');p=load_plan(a.plan)
    # Concurrent local manual/timer runs must not both start services.
    fd=os.open(p['stage']+'/operation.lock',os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        print(json.dumps(status(p) if a.action=='check' else resume(p)))
    finally:os.close(fd)


if __name__=='__main__':
    try:main()
    except Exception as e:
        print(json.dumps(dict(error=str(e) if isinstance(e,RuntimeError) else type(e).__name__)),file=sys.stderr)
        raise SystemExit(1)

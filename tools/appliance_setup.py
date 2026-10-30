#!/usr/bin/env python3
"""Neutral first-install/upgrade entry point over the production Compose release.

Takes local, operator-provisioned storage/ROM/model/secret references; never
formats a disk, seeds an account, or copies a development appliance's state.
"""
import argparse
import json
import os
from pathlib import Path
import re
import secrets
import uuid
from appliance_installation import execute, imported, inspect, load, save, validate, resolve
from appliance_network_identity import atomic_write
from appliance_networks import prepare, ENV


def initialize(path, root, node_id=None):
    path, root = Path(path), Path(root)
    if path.exists():
        record=load(path)
        if node_id and node_id!=record['nodeId']: raise ValueError('installation_node_identity_conflict')
        if record['references'].get('installationRoot')!=str(root.resolve()):raise ValueError('installation_root_conflict')
        return record
    if not root.is_absolute() or root==Path('/') or '..' in root.parts:raise ValueError('installation_root_invalid')
    node_id=node_id or str(uuid.uuid4());identity=str(uuid.uuid4())
    record=validate(dict(version=1,installationId=identity,nodeId=node_id,services={},references={'installationRoot':str(root)},networks={
        # These two names are existing runtime protocol roles, not developer
        # machine identities. Keep their contract while owning/creating them.
        role:{'name':role if role in ('plugin-ingress','compute-internal') else 'teamaibox-'+identity[:12]+'-'+role,'internal':True} for role in ENV}))
    root.mkdir(parents=True,exist_ok=True,mode=0o700)
    save(path,record)
    return record


def generate_secrets(directory):
    """Independent setup/service factors only; TLS provisioning stays explicit."""
    directory=Path(directory);directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    for name in ('postgres-password','nats-password','owner-setup-token','audit-signing-key','object-wrapping-key','provider-secret-master-key'):
        path=directory/name
        if path.exists():
            info=path.lstat()
            if path.is_symlink() or not path.is_file() or info.st_mode&0o077:raise ValueError('existing_secret_file_unsafe')
            continue
        fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as f:f.write(secrets.token_urlsafe(32));f.flush();os.fsync(f.fileno())


def compose_args(record, env, compose):
    if not Path(env).is_absolute() or not Path(compose).is_file():raise ValueError('explicit_installation_env_and_compose_required')
    return ['docker','compose','--project-name','teamaibox-'+record['installationId'][:12],
            '--env-file',env,'--env-file',record['references']['networkEnvironment'],'-f',str(Path(compose).resolve())]


def prepare_installation(path, env, compose):
    record=load(path)
    netenv=Path(path).with_name('networks.env')
    atomic_write(netenv,('\n'.join(ENV[r]+'='+record['networks'][r]['name'] for r in ENV)+'\n').encode(),0o600)
    record['references']['networkEnvironment']=str(netenv);record['references']['composeFile']=str(Path(compose).resolve());record['references']['composeEnvironment']=env
    rendered=json.loads(execute([*compose_args(record,env,compose),'config','--format','json']))
    api=rendered.get('services',{}).get('platform-api',{})
    if api.get('environment',{}).get('PLATFORM_APPLIANCE_NODE_ID')!=record['nodeId']:raise ValueError('compose_node_identity_mismatch')
    if 'node-agent' in rendered.get('services',{}):
        for role in ('plugin-ingress','compute-internal'):
            if record['networks'][role]['name']!=role:raise ValueError('runtime_network_role_name_mismatch:'+role)
    for service in rendered['services'].values():
        if not re.fullmatch(r'(?:[^\s]+@)?sha256:[0-9a-f]{64}',service.get('image','')):raise ValueError('release_images_must_be_digest_pinned')
    record=prepare(record)
    save(path,record)
    return record


def apply(path, env, compose, roles):
    record=prepare_installation(path,env,compose)
    if record['services']:
        # Repeating install is a check, not an implicit Compose recreate.
        for role in roles:
            if not resolve(record,role)['State']['Running']:raise ValueError('installed_service_not_running_use_recovery')
        return {'status':'unchanged','installationId':record['installationId'],'services':list(record['services'])}
    # Compose resumes a partial first install. It never runs `down -v`, removes
    # or replaces customer guests; operators retain configuration on failure.
    args=compose_args(record,env,compose)
    execute([*args,'up','-d','--no-build','--pull','never','--wait','--wait-timeout','120'],timeout=150)
    mapping={}
    for role,service in roles.items():
        ids=execute([*args,'ps','-q',service]).split()
        if len(ids)!=1:raise ValueError('compose_service_resolution_ambiguous:'+role)
        mapping[role]=inspect(ids[0])
    adopted=imported(record['nodeId'],mapping)
    record['services']=adopted['services'];record['references'].update(adopted['references']);save(path,record)
    return {'status':'installed','installationId':record['installationId'],'services':list(record['services'])}


def prerequisites(path, contract, storage_configuration):
    library=Path(__file__).resolve().parent
    execute(['python3',str(library/'appliance_compatibility.py'),'--installation',path,'--contract',contract])
    execute(['python3',str(library/'restore_existing_business_volumes.py'),'--configuration',storage_configuration,'--check'],timeout=180)
    record=load(path);record['references'].update(compatibilityContract=str(Path(contract).resolve()),storageVolumes=str(Path(storage_configuration).resolve()))
    save(path,record)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--installation',required=True)
    subs=parser.add_subparsers(dest='action',required=True)
    init=subs.add_parser('init');init.add_argument('--root',required=True);init.add_argument('--node-id')
    for name in ('prepare','apply'):
        p=subs.add_parser(name);p.add_argument('--env-file',required=True);p.add_argument('--compose',required=True)
        p.add_argument('--contract',required=True);p.add_argument('--storage-configuration',required=True)
        if name=='apply':p.add_argument('--role',action='append',required=True)
    args=parser.parse_args()
    if os.geteuid()!=0:raise PermissionError('root_required')
    if args.action=='init':
        record=initialize(args.installation,args.root,args.node_id);generate_secrets(Path(args.root)/'secrets')
        print(json.dumps({'status':'initialized','installationId':record['installationId'],'nodeId':record['nodeId'],'existingDataChanged':False}))
    elif args.action=='prepare':
        prerequisites(args.installation,args.contract,args.storage_configuration)
        prepare_installation(args.installation,args.env_file,args.compose);print(json.dumps({'status':'prepared'}))
    else:
        roles=dict(r.split('=',1) for r in args.role)
        prerequisites(args.installation,args.contract,args.storage_configuration)
        result=apply(args.installation,args.env_file,args.compose,roles)
        baseline=Path(args.installation).with_name('host-baseline.json')
        if baseline.exists():
            if result['status']!='unchanged':raise ValueError('existing_baseline_requires_explicit_review')
        else:
            execute(['python3',str(Path(__file__).resolve().parent/'appliance_compatibility.py'),'--installation',args.installation,'--contract',args.contract,'--record-baseline',str(baseline)])
        record=load(args.installation);record['references']['hostBaseline']=str(baseline);save(args.installation,record)
        print(json.dumps(result))


if __name__=='__main__':main()

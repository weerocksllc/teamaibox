#!/usr/bin/env python3
"""Isolated lifecycle smoke: real Docker/Compose, no product data or guest disks.

Uses two independent roots and node IDs. The fixture service only idles; this
checks the installer/upgrader, not a second physical Spark or business flows.
"""
import argparse
import copy
import json
import os
from pathlib import Path
import tempfile
from urllib.parse import quote
import appliance_delivery as delivery
import appliance_installation as installation
import appliance_networks as networks
import appliance_setup as setup


def check(ok, reason):
    if not ok: raise AssertionError(reason)


def main():
    p=argparse.ArgumentParser();p.add_argument('--base-image',required=True);p.add_argument('--contract',required=True);p.add_argument('--output',required=True)
    args=p.parse_args()
    if os.geteuid()!=0:raise PermissionError('root_required')
    stage=Path(tempfile.mkdtemp(prefix='teamaibox-installation-fixture-'))
    records=[];owned_containers=set();owned_networks=set();images=[];results=[]
    try:
        for revision in (1,2):
            dockerfile=stage/f'Dockerfile.{revision}'
            dockerfile.write_text('FROM '+args.base_image+'\nLABEL com.teamaibox.fixture="portable-install" revision="'+str(revision)+'"\nENTRYPOINT ["node"]\nCMD ["-e","setInterval(()=>{},1000)"]\nHEALTHCHECK --interval=1s --timeout=2s --retries=5 CMD ["node","-e","process.exit(0)"]\n')
            # Build output includes the exact image digest (no registry access).
            digest=installation.execute(['docker','build','--network=none','--pull=false','-q','-f',str(dockerfile),str(stage)],timeout=120).strip().splitlines()[-1]
            check(digest.startswith('sha256:'),'image digest');images.append(digest)
        for n in (1,2):
            root=stage/f'customer-{n}';path=root/'installation.json';record=setup.initialize(path,root)
            # This fixture has no business Agent/policy; vary physical names to
            # exercise ownership without occupying the product's role names.
            for role in networks.ENV:record['networks'][role]['name']='fixture-'+record['installationId'][:12]+'-'+role
            installation.save(path,record)
            setup.generate_secrets(root/'secrets')
            setup.generate_secrets(root/'secrets')
            env=root/'installation.env';env.write_text('FIXTURE_NODE='+record['nodeId']+'\nFIXTURE_IMAGE='+images[0]+'\n')
            compose=root/'release.json'
            compose.write_text(json.dumps({'services':{'platform-api':{'image':'${FIXTURE_IMAGE}','environment':{'PLATFORM_APPLIANCE_NODE_ID':'${FIXTURE_NODE}'},'networks':['internal'],'mem_limit':'64m','pids_limit':32,'cpus':0.1}},'networks':{'internal':{'external':True,'name':'${TEAMAIBOX_COMPUTE_INTERNAL_NETWORK}'}}}))
            storage=root/'storage.json';storage.write_text('{"version":1,"volumes":[]}')
            setup.prerequisites(str(path),args.contract,str(storage))
            prepared=setup.prepare_installation(str(path),str(env),str(compose));records.append((path,prepared))
            owned_networks.update(s['id'] for s in prepared['networks'].values())
            setup.apply(str(path),str(env),str(compose),{'platform-api':'platform-api'})
            record=installation.load(path);records[-1]=(path,record)
            owned_containers.add(record['services']['platform-api']['containerId']);owned_networks.update(s['id'] for s in record['networks'].values())
            before=copy.deepcopy(record)
            check(setup.apply(str(path),str(env),str(compose),{'platform-api':'platform-api'})['status']=='unchanged','repeat installation recreates service')
            check(installation.load(path)==before,'repeat changed record')
            old=installation.resolve(record,'platform-api');newname='teamaibox-'+record['installationId'][:12]+'-platform-api-'+images[1][7:19]
            new=delivery.docker_api('POST','/containers/create?name='+quote(newname),delivery.replacement(old,images[1]))['Id'];owned_containers.add(new)
            journal=root/'upgrade.json'
            job=dict(version=1,installationId=record['installationId'],role='platform-api',previous=record['services']['platform-api'],
                oldName=old['Name'][1:],oldRestart=old['HostConfig']['RestartPolicy'],name=newname,imageId=images[1],
                status='created',newId=new,configuration=[],protected=installation.inventory((old['Id'],new)))
            delivery.journal_write(journal,job)
            foreign=root/'foreign.json';wrong=copy.deepcopy(job);wrong['installationId']='00000000-0000-4000-8000-000000000000';delivery.journal_write(foreign,wrong)
            try:delivery.resume(path,foreign)
            except ValueError:pass
            else:raise AssertionError('foreign journal accepted')
            check(delivery.resume(path,journal)['status']=='complete','interrupted upgrade resume')
            check(delivery.resume(path,journal)['status']=='unchanged','completed resume')
            check(delivery.rollback(path,journal)['status']=='rolled_back','exact rollback')
            check(installation.resolve(installation.load(path),'platform-api')['Id']==old['Id'],'rollback exact identity')
            check(delivery.replace(path,'platform-api',images[1],journal)['status']=='complete','normal upgrade')
            check(delivery.replace(path,'platform-api',images[1],journal)['status']=='unchanged','same release recreates')
            results.append(dict(installationId=record['installationId'],nodeId=record['nodeId'],networkIds=[s['id'] for s in record['networks'].values()],checks=['install','repeat','foreign-journal-rejected','interrupted-resume','exact-rollback','upgrade','same-image-no-change']))
        check(records[0][1]['nodeId']!=records[1][1]['nodeId'],'shared identity')
        check((stage/'customer-1/secrets/postgres-password').read_bytes()!=(stage/'customer-2/secrets/postgres-password').read_bytes(),'shared secret')
        print(json.dumps({'status':'passed','installations':results}))
    finally:
        # Exact IDs recorded by this fixture only. No Compose down or volume prune.
        for cid in owned_containers:
            current=installation.inspect(cid)
            check((current['Config'].get('Labels') or {}).get('com.teamaibox.fixture')=='portable-install','cleanup ownership')
            installation.execute(['docker','rm','-f',cid])
        for cid in owned_networks:
            actual=json.loads(installation.execute(['docker','network','inspect',cid]))[0]
            check(not actual.get('Containers') and actual.get('Labels',{}).get('com.teamaibox.installation-id') in [r['installationId'] for _,r in records],'cleanup network ownership')
            installation.execute(['docker','network','rm',cid])
        for digest in images:installation.execute(['docker','image','rm',digest])
        Path(args.output).write_text(json.dumps({'status':'passed' if len(results)==2 else 'failed','installations':results,'fixtureRoot':str(stage),'runtimeResourcesCleaned':True,'scope':'installer lifecycle only, no business acceptance'},indent=2)+'\n')


if __name__=='__main__':main()

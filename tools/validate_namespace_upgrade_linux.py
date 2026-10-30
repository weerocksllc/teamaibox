#!/usr/bin/env python3
"""One disposable API/sidecar cohort; never mounts product data."""
import argparse
import copy
import json
import os
from pathlib import Path
import tempfile
import uuid
from urllib.parse import quote
import appliance_delivery as delivery
import appliance_installation as installation


def require(value, reason):
    if not value: raise AssertionError(reason)


def main():
    p=argparse.ArgumentParser();p.add_argument('--base-image',required=True);p.add_argument('--output',required=True)
    args=p.parse_args()
    if os.geteuid()!=0:raise PermissionError('root_required')
    root=Path(tempfile.mkdtemp(prefix='teamaibox-namespace-fixture-'))
    owned=set();images=[];checks=[];journal=root/'upgrade.json';path=root/'installation.json'
    node=str(uuid.uuid4());fixture=str(uuid.uuid4())
    try:
        for revision in (1,2):
            dockerfile=root/f'Dockerfile.{revision}'
            dockerfile.write_text('FROM '+args.base_image+'\nLABEL com.teamaibox.fixture="namespace-upgrade" revision="'+str(revision)+'"\nENTRYPOINT ["node"]\nCMD ["-e","setInterval(()=>{},1000)"]\nHEALTHCHECK --interval=1s --timeout=2s --retries=5 CMD ["node","-e","process.exit(0)"]\n')
            images.append(installation.execute(['docker','build','--network=none','--pull=false','-q','-f',str(dockerfile),str(root)],timeout=120).strip().splitlines()[-1])
        services={}
        for role in ('platform-api','node-agent','appliance-gateway'):
            payload={'Image':images[0],'Env':['PLATFORM_APPLIANCE_NODE_ID='+node],
                     'Labels':{'com.teamaibox.installation-id':fixture,'com.teamaibox.service-role':role,'com.teamaibox.fixture':'namespace-upgrade'},
                     'HostConfig':{'NetworkMode':'none' if role=='platform-api' else 'container:'+services['platform-api']['Id'],
                                   'Memory':64*1024*1024,'PidsLimit':32,'NanoCpus':100000000}}
            cid=delivery.docker_api('POST','/containers/create?name='+quote('fixture-'+fixture[:8]+'-'+role),payload)['Id'];owned.add(cid)
            delivery.docker_api('POST','/containers/'+cid+'/start');delivery.wait_healthy(cid)
            services[role]=installation.inspect(cid)
        record=installation.imported(node,services);installation.save(path,record)
        original=copy.deepcopy(record['services'])
        # A dependent without a registered role must not broaden the write scope.
        payload=delivery.replacement(services['node-agent'],images[0])
        stray=delivery.docker_api('POST','/containers/create?name='+quote('fixture-'+fixture[:8]+'-unregistered'),payload)['Id'];owned.add(stray)
        try:delivery.replace(path,'platform-api',images[1],journal)
        except ValueError as error:require(str(error)=='namespace_dependent_requires_explicit_role_import','wrong identity guard')
        else:raise AssertionError('unregistered dependent accepted')
        require(installation.load(path)['services']==original and not journal.exists(),'guard mutated installation')
        installation.execute(['docker','rm',stray]);owned.remove(stray);checks.append('unknown-dependent-rejected-before-write')

        class Interruption(BaseException):pass
        original_write=delivery.journal_write
        def interrupted_write(target,job):
            original_write(target,job)
            if job.get('status')=='old_stopped':raise Interruption()
        delivery.journal_write=interrupted_write
        try:delivery.replace(path,'platform-api',images[1],journal)
        except Interruption:pass
        finally:delivery.journal_write=original_write
        job=json.loads(journal.read_text());owned.update(i['newId'] for i in job['members'].values())
        require(job['status']=='old_stopped','interruption point')
        require(delivery.resume(path,journal)['status']=='complete','group resume')
        current=installation.load(path);parent=current['services']['platform-api']['containerId']
        for role in ('node-agent','appliance-gateway'):
            require(installation.resolve(current,role)['HostConfig']['NetworkMode']=='container:'+parent,'stale namespace')
        require(delivery.resume(path,journal)['status']=='unchanged','completed resume')
        checks.extend(['interrupted-cohort-resumed','sidecars-use-new-api-namespace','completed-resume-idempotent'])
        require(delivery.rollback(path,journal)['status']=='rolled_back','group rollback')
        require(installation.load(path)['services']==original,'rollback identity')
        checks.append('exact-cohort-rollback')
    finally:
        if journal.exists():
            owned.update(i['newId'] for i in json.loads(journal.read_text()).get('members',{}).values() if i.get('newId'))
        for cid in owned:
            c=installation.inspect(cid)
            require((c['Config'].get('Labels') or {}).get('com.teamaibox.fixture')=='namespace-upgrade','cleanup ownership')
            installation.execute(['docker','rm','-f',cid])
        for digest in images:installation.execute(['docker','image','rm',digest])
        result={'status':'passed' if len(checks)==5 else 'failed','checks':checks,'runtimeResourcesCleaned':True,
                'fixtureRoot':str(root),'scope':'isolated namespace upgrade only; no product volumes'}
        Path(args.output).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))


if __name__=='__main__':main()

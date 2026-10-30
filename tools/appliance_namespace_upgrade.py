"""Exact upgrade cohort for Compose services sharing an API network namespace.

Only explicitly registered sidecars are replaced. Guest/model/container name
discovery never authorizes a mutation. Independent namespaces stay independent.
"""
import copy
import json
from pathlib import Path
from urllib.parse import quote
import uuid
from appliance_installation import execute, inspect, inventory, service_record, save
from appliance_network_identity import atomic_write


def dependents(record, parent):
    ids=execute(['docker','ps','-aq','--no-trunc']).split()
    rows=json.loads(execute(['docker','inspect',*ids])) if ids else []
    roles={s['containerId']:r for r,s in record['services'].items()}
    matched={}
    for c in rows:
        if c['HostConfig']['NetworkMode'] not in ('container:'+parent['Id'],'container:'+parent['Name'].lstrip('/')):continue
        if c['Id'] not in roles:raise ValueError('namespace_dependent_requires_explicit_role_import')
        role=roles[c['Id']]
        if service_record(c)!=record['services'][role]:raise ValueError('namespace_dependent_identity_changed')
        if not c['Config'].get('Healthcheck'):raise ValueError('namespace_dependent_healthcheck_required')
        matched[role]=c
    return matched


def replace_group(path,record,role,parent,image,group,journal,patch_file):
    from appliance_delivery import journal_write
    if Path(journal).exists():raise ValueError('namespace_group_journal_exists_use_resume_or_new_journal_after_rollback')
    rows={role:parent,**group};upgrade=str(uuid.uuid4())
    if any(not c['State']['Running'] for c in rows.values()):
        raise ValueError('namespace_group_requires_running_services')
    job=dict(version=1,namespaceGroup=True,installationId=record['installationId'],role=role,upgradeId=upgrade,status='prepared',configuration=[],members={})
    for r,c in rows.items():
        job['members'][r]=dict(previous=record['services'][r],restart=c['HostConfig']['RestartPolicy'],
            imageId=image['Id'] if r==role else c['Image'],name='teamaibox-'+record['installationId'][:12]+'-'+r+'-'+upgrade[:8])
    job['protected']=inventory(tuple(c['Id'] for c in rows.values()))
    for reference,patch in (json.loads(Path(patch_file).read_text()) if patch_file else {}).items():
        target=Path(record['references'][reference])
        if target.is_symlink() or not isinstance(patch,dict):raise ValueError('configuration_patch_invalid')
        raw=target.read_bytes();saved=str(Path(journal).with_name(Path(journal).name+'.'+reference+'.previous'))
        if Path(saved).exists():raise ValueError('configuration_journal_already_exists')
        atomic_write(saved,raw,0o600)
        job['configuration'].append(dict(path=str(target),previous=saved,updated={**json.loads(raw),**patch}))
    journal_write(journal,job)
    return resume_group(path,journal,record,job)


def validate(record,job):
    if record['installationId']!=job['installationId']:raise ValueError('namespace_upgrade_installation_mismatch')
    for role,item in job['members'].items():
        if service_record(inspect(item['previous']['containerId']))!=item['previous']:raise ValueError('namespace_upgrade_source_changed')
        current=record['services'][role]
        if current!=item['previous'] and (not item.get('newId') or current!=service_record(inspect(item['newId']))):raise ValueError('namespace_upgrade_role_changed')
        if item.get('newId'):
            c=inspect(item['newId'])
            if c['Image']!=item['imageId'] or c['Name']!='/'+item['name'] or (c['Config'].get('Labels') or {}).get('com.teamaibox.upgrade-id')!=job['upgradeId']:
                raise ValueError('namespace_upgrade_target_changed')


def order(job):return [job['role'],*[r for r in job['members'] if r!=job['role']]]


def rollback_group(path,journal,record,job):
    from appliance_delivery import docker_api,wait_healthy,journal_write
    validate(record,job)
    for role in reversed(order(job)):
        item=job['members'][role]
        if item.get('newId'):
            docker_api('POST','/containers/'+item['newId']+'/update',{'RestartPolicy':{'Name':'no'}})
            docker_api('POST','/containers/'+item['newId']+'/stop?t=20')
    for c in job['configuration']:atomic_write(c['path'],Path(c['previous']).read_bytes())
    for role in order(job):
        item=job['members'][role];cid=item['previous']['containerId']
        docker_api('POST','/containers/'+cid+'/update',{'RestartPolicy':item['restart']})
        docker_api('POST','/containers/'+cid+'/start');wait_healthy(cid)
        record['services'][role]=item['previous']
    save(path,record);job['status']='rolled_back';journal_write(journal,job)
    return {'status':'rolled_back','roles':order(job)}


def resume_group(path,journal,record,job):
    from appliance_delivery import docker_api,wait_healthy,journal_write,replacement
    validate(record,job)
    if job['status']=='complete':
        if any(record['services'][r]['containerId']!=i['newId'] for r,i in job['members'].items()):raise ValueError('namespace_completed_roles_changed')
        return {'status':'unchanged','roles':order(job)}
    if job['status']=='rolled_back':raise ValueError('rolled_back_group_requires_new_upgrade_journal')
    try:
        for role in order(job):
            item=job['members'][role]
            if item.get('newId'):continue
            candidate=None
            try:candidate=inspect(item['name'])
            except RuntimeError:pass
            if candidate:
                if candidate['Image']!=item['imageId'] or (candidate['Config'].get('Labels') or {}).get('com.teamaibox.upgrade-id')!=job['upgradeId']:
                    raise ValueError('namespace_staged_name_collision')
                item['newId']=candidate['Id']
            else:
                payload=replacement(inspect(item['previous']['containerId']),item['imageId'])
                payload['Labels']={**(payload.get('Labels') or {}),'com.teamaibox.upgrade-id':job['upgradeId']}
                if role!=job['role']:
                    payload['HostConfig']['NetworkMode']='container:'+job['members'][job['role']]['newId']
                    payload.pop('ExposedPorts',None);payload.pop('NetworkingConfig',None)
                item['newId']=docker_api('POST','/containers/create?name='+quote(item['name']),payload)['Id']
            journal_write(journal,job)
        excluded=[v for i in job['members'].values() for v in (i['newId'],i['previous']['containerId'])]
        for c in job['configuration']:atomic_write(c['path'],(json.dumps(c['updated'])+'\n').encode())
        for role in reversed(order(job)):
            item=job['members'][role];cid=item['previous']['containerId']
            docker_api('POST','/containers/'+cid+'/update',{'RestartPolicy':{'Name':'no'}})
            docker_api('POST','/containers/'+cid+'/stop?t=20')
        job['status']='old_stopped';journal_write(journal,job)
        for role in order(job):
            cid=job['members'][role]['newId']
            docker_api('POST','/containers/'+cid+'/start');wait_healthy(cid)
        if inventory(excluded)!=job['protected']:raise RuntimeError('protected_resources_changed')
        for role,item in job['members'].items():record['services'][role]=service_record(inspect(item['newId']))
        save(path,record);job['status']='complete';journal_write(journal,job)
        return {'status':'complete','roles':order(job),'namespaceOwner':job['members'][job['role']]['newId']}
    except Exception:
        rollback_group(path,journal,record,job);raise

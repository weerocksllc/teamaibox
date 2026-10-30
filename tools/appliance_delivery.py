#!/usr/bin/env python3
"""Bounded installation import and service replacement. Never replaces guests."""
import argparse
import copy
import http.client
import json
import os
import socket
import time
import uuid
from pathlib import Path
from urllib.parse import quote
from appliance_installation import DEFAULT, execute, imported, inspect, inventory, load, resolve, save, service_record
from appliance_network_identity import atomic_write


def docker_api(method, path, body=None):
    class Connection(http.client.HTTPConnection):
        def connect(self):
            self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            self.sock.connect('/var/run/docker.sock')
    connection = Connection('localhost', timeout=60)
    connection.request(method, '/v1.47' + path, json.dumps(body) if body is not None else None, {'Content-Type': 'application/json'})
    response = connection.getresponse(); raw = response.read(); connection.close()
    if response.status not in (200, 201, 204, 304):
        message = json.loads(raw).get('message', '')[:240] if raw else ''
        raise RuntimeError('service_operation_failed:' + str(response.status) + ':' + message)
    return json.loads(raw) if raw else None


def replacement(c, image):
    payload = copy.deepcopy(c['Config']); payload['Image'] = image; payload['Hostname'] = ''
    hc = copy.deepcopy(c['HostConfig']); payload['HostConfig'] = hc
    mode = hc['NetworkMode']
    if mode.startswith('container:'):
        # Inherited image ports are allowed, explicit publications are not in
        # a shared control namespace. Docker inspect materializes both alike.
        payload.pop('ExposedPorts', None)
    if mode not in ('host', 'none', 'default') and not mode.startswith('container:'):
        payload['NetworkingConfig'] = {'EndpointsConfig': {
            n: {k: v for k, v in dict(Aliases=[a for a in (network.get('Aliases') or []) if a not in (c['Id'][:12], c['Name'][1:])],
                                      IPAMConfig=network.get('IPAMConfig')).items() if v}
            for n, network in c['NetworkSettings']['Networks'].items()}}
    return payload


def wait_healthy(cid):
    for _ in range(60):
        c = inspect(cid)
        if c['State'].get('Health', {}).get('Status') == 'healthy': return
        if not c['State']['Running']: raise RuntimeError('replacement_exited')
        time.sleep(2)
    raise RuntimeError('replacement_not_healthy')


def journal_write(path, value):
    atomic_write(path, (json.dumps(value, indent=2) + '\n').encode(), 0o600)


def configuration_changes(record, patch_file):
    changes=json.loads(Path(patch_file).read_text()) if patch_file else {}
    if not isinstance(changes,dict):raise ValueError('configuration_patch_invalid')
    for reference,patch in changes.items():
        target=Path(record['references'][reference])
        if target.is_symlink() or not isinstance(patch,dict):raise ValueError('configuration_patch_invalid')
    return {ref:patch for ref,patch in changes.items()
            if any(json.loads(Path(record['references'][ref]).read_text()).get(k)!=v for k,v in patch.items())}


def replace(path, role, image, journal, patch_file=None):
    record = load(path); old = resolve(record, role)
    selected = json.loads(execute(['docker', 'image', 'inspect', image]))[0]
    if selected['Architecture'] != 'arm64' or selected['Os'] != 'linux': raise ValueError('service_image_architecture')
    if Path(journal).exists():
        pending=json.loads(Path(journal).read_text())
        if pending['status'] in ('created','old_stopped') or pending.get('namespaceGroup') and pending['status']=='prepared':
            wanted=pending['members'][role]['imageId'] if pending.get('namespaceGroup') and role in pending['members'] else pending.get('imageId')
            if pending['installationId']!=record['installationId'] or pending['role']!=role or wanted!=selected['Id']:
                raise ValueError('pending_journal_target_conflict')
            return resume(path,journal)
    changes=configuration_changes(record,patch_file)
    if old['Image'] == selected['Id'] and not changes: return {'status': 'unchanged', 'containerId': old['Id']}
    if not old['Config'].get('Healthcheck'): raise ValueError('service_healthcheck_required')
    from appliance_namespace_upgrade import dependents, replace_group
    group=dependents(record,old)
    if group:return replace_group(path,record,role,old,selected,group,journal,patch_file)
    previous = None
    if Path(journal).exists():
        previous = json.loads(Path(journal).read_text())
        if previous['status'] not in ('prepared','rolled_back') or previous['previous']['containerId'] != old['Id'] or previous['imageId'] != selected['Id']:
            raise ValueError('pending_journal_use_resume_or_rollback')
    protected = inventory((old['Id'],))
    name = 'teamaibox-' + record['installationId'][:12] + '-' + role + '-' + selected['Id'][7:19]
    if old['Image']==selected['Id']:
        name=(previous or {}).get('name') or name+'-'+str(uuid.uuid4())[:8]
    job = dict(version=1, installationId=record['installationId'], role=role, previous=record['services'][role],
               oldName=old['Name'][1:], oldRestart=old['HostConfig']['RestartPolicy'], name=name,
               imageId=selected['Id'], status='prepared', protected=protected,
               upgradeId=(previous or {}).get('upgradeId') or str(uuid.uuid4()))
    job['configuration'] = []
    for reference, patch in changes.items():
        target = record['references'][reference]
        if Path(target).is_symlink() or not isinstance(patch, dict): raise ValueError('configuration_patch_invalid')
        raw = Path(target).read_bytes()
        current = json.loads(raw)
        saved = str(Path(journal).with_name(Path(journal).name + '.' + reference + '.previous'))
        if Path(saved).exists():
            if Path(saved).read_bytes() != raw: raise ValueError('configuration_changed_since_prepare')
        else: atomic_write(saved, raw, 0o600)
        job['configuration'].append(dict(path=target, previous=saved, updated={**current, **patch}))
    journal_write(journal, job)
    if previous and previous.get('newId'):
        candidate=inspect(previous['newId'])
        if candidate['Name']!='/'+name or candidate['Image']!=selected['Id'] or candidate['State']['Running']:
            raise ValueError('staged_replacement_identity_changed')
        new=candidate['Id']
    else:
        # Recover interruption between Docker create and journal update. A name
        # alone is not ownership: require the ID of this persisted upgrade job.
        candidate=None
        if previous:
            try:candidate=inspect(name)
            except RuntimeError:pass
        if candidate:
            if candidate['Image']!=selected['Id'] or candidate['State']['Running'] or (candidate['Config'].get('Labels') or {}).get('com.teamaibox.upgrade-id')!=job['upgradeId']:
                raise ValueError('unowned_replacement_name_collision')
            new=candidate['Id']
        else:
            payload=replacement(old,selected['Id'])
            payload['Labels']={**(payload.get('Labels') or {}),'com.teamaibox.upgrade-id':job['upgradeId']}
            new = docker_api('POST', '/containers/create?name=' + quote(name), payload)['Id']
    job.update(newId=new, status='created'); journal_write(journal, job)
    try:
        for config in job['configuration']:
            atomic_write(config['path'], (json.dumps(config['updated'])+'\n').encode())
        docker_api('POST', '/containers/' + old['Id'] + '/update', {'RestartPolicy': {'Name': 'no'}})
        docker_api('POST', '/containers/' + old['Id'] + '/stop?t=20')
        job['status'] = 'old_stopped'; journal_write(journal, job)
        docker_api('POST', '/containers/' + new + '/start'); wait_healthy(new)
        if inventory((old['Id'], new)) != protected: raise RuntimeError('protected_resources_changed')
        record['services'][role] = service_record(inspect(new)); save(path, record)
        job['status'] = 'complete'; journal_write(journal, job)
        return {'status': 'complete', 'role': role, 'containerId': new}
    except Exception:
        rollback(path, journal)
        raise


def rollback(path, journal):
    record = load(path); job = json.loads(Path(journal).read_text())
    if job.get('namespaceGroup'):
        from appliance_namespace_upgrade import rollback_group
        return rollback_group(path,journal,record,job)
    if job['installationId'] != record['installationId']: raise ValueError('rollback_installation_mismatch')
    old = inspect(job['previous']['containerId'])
    if service_record(old) != job['previous']: raise ValueError('rollback_source_changed')
    if job.get('newId'):
        new = inspect(job['newId'])
        if new['Image'] != job['imageId'] or new['Name'] != '/' + job['name']: raise ValueError('rollback_target_changed')
        docker_api('POST', '/containers/' + new['Id'] + '/update', {'RestartPolicy': {'Name': 'no'}})
        docker_api('POST', '/containers/' + new['Id'] + '/stop?t=20')
    for config in job.get('configuration', []):
        atomic_write(config['path'], Path(config['previous']).read_bytes())
    docker_api('POST', '/containers/' + old['Id'] + '/update', {'RestartPolicy': job['oldRestart']})
    docker_api('POST', '/containers/' + old['Id'] + '/start'); wait_healthy(old['Id'])
    record['services'][job['role']] = job['previous']; save(path, record)
    job['status'] = 'rolled_back'; journal_write(journal, job)
    return {'status': 'rolled_back'}


def resume(path, journal):
    record=load(path);job=json.loads(Path(journal).read_text())
    if job.get('namespaceGroup'):
        from appliance_namespace_upgrade import resume_group
        return resume_group(path,journal,record,job)
    if record['installationId']!=job['installationId']:raise ValueError('resume_installation_mismatch')
    if job['status']=='complete':
        if resolve(record,job['role'])['Id']!=job['newId']:raise ValueError('completed_service_changed')
        return {'status':'unchanged','containerId':job['newId']}
    if job['status'] not in ('created','old_stopped'):raise ValueError('resume_requires_created_replacement')
    if record['services'][job['role']] not in (job['previous'],service_record(inspect(job['newId']))):raise ValueError('resume_role_changed')
    new=inspect(job['newId']);old=inspect(job['previous']['containerId'])
    if new['Name']!='/'+job['name'] or new['Image']!=job['imageId'] or service_record(old)!=job['previous']:
        raise ValueError('resume_container_identity_changed')
    try:
        for c in job.get('configuration',[]):atomic_write(c['path'],(json.dumps(c['updated'])+'\n').encode())
        docker_api('POST','/containers/'+old['Id']+'/update',{'RestartPolicy':{'Name':'no'}})
        docker_api('POST','/containers/'+old['Id']+'/stop?t=20')
        docker_api('POST','/containers/'+new['Id']+'/start');wait_healthy(new['Id'])
        if inventory((old['Id'],new['Id']))!=job['protected']:raise RuntimeError('protected_resources_changed')
        record['services'][job['role']]=service_record(inspect(new['Id']));save(path,record)
        job['status']='complete';journal_write(journal,job)
        return {'status':'complete','containerId':new['Id']}
    except Exception:
        rollback(path,journal);raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installation', default=str(DEFAULT))
    sub = parser.add_subparsers(dest='action', required=True)
    imp = sub.add_parser('import'); imp.add_argument('--node-id', required=True); imp.add_argument('--role', action='append', required=True)
    imp.add_argument('--check', action='store_true')
    sub.add_parser('inspect')
    inv = sub.add_parser('inventory'); inv.add_argument('--output', required=True)
    rep = sub.add_parser('replace'); rep.add_argument('--role', required=True); rep.add_argument('--image', required=True); rep.add_argument('--journal', required=True); rep.add_argument('--config-patch')
    rb = sub.add_parser('rollback'); rb.add_argument('--journal', required=True)
    resume_parser = sub.add_parser('resume'); resume_parser.add_argument('--journal', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0: raise PermissionError('root_required')
    if args.action == 'import':
        services = {}
        for item in args.role:
            role, cid = item.split('=', 1)
            if role in services: raise ValueError('duplicate_role')
            services[role] = inspect(cid)
        record = imported(args.node_id, services, load(args.installation) if Path(args.installation).exists() else None)
        if not args.check: save(args.installation, record)
        result = {'status': 'checked' if args.check else 'imported', 'services': list(record['services'])}
    elif args.action == 'inventory':
        atomic_write(args.output, (json.dumps(inventory(), indent=2)+'\n').encode(), 0o600)
        result = {'status': 'recorded'}
    elif args.action == 'inspect':
        record = load(args.installation)
        result = {'nodeId': record['nodeId'], 'services': {r: resolve(record, r)['Id'] for r in record['services']}}
    elif args.action == 'replace': result = replace(args.installation, args.role, args.image, args.journal, args.config_patch)
    elif args.action == 'resume': result = resume(args.installation, args.journal)
    else: result = rollback(args.installation, args.journal)
    print(json.dumps(result))


if __name__ == '__main__': main()

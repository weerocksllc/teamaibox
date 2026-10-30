#!/usr/bin/env python3
"""Create fresh office workers and bind the existing boot recovery adapter.

This adapter only operates on names derived from the installation UUID. It
never adopts a foreign container, replaces a container, pulls an image or
starts a model while constructing the recovery manifest.
"""
import argparse
from copy import deepcopy
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import socket
import sys
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from offline_common import need, read_json, write_json
from restore_existing_office_workers import configuration_digest, validate_identity


class DockerSocket(http.client.HTTPConnection):
    def __init__(self, path='/var/run/docker.sock'):
        super().__init__('localhost', timeout=60)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def docker(method, path, document=None):
    connection = DockerSocket()
    try:
        body = None if document is None else json.dumps(document).encode()
        connection.request(method, '/v1.48' + path, body, {'Content-Type': 'application/json'})
        response = connection.getresponse()
        raw = response.read(16 * 1024 * 1024 + 1)
        need(len(raw) <= 16 * 1024 * 1024, 'Docker response exceeded expected size')
        # Never print Docker's error body: it can contain command/env values.
        return response.status, json.loads(raw) if raw else None
    finally:
        connection.close()


def request_digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def owned_container(actual, request, installation_id, name):
    labels = actual.get('Config', {}).get('Labels') or {}
    need(actual.get('Name') == '/' + name and re.fullmatch('[a-f0-9]{64}', actual.get('Id', ''))
         and actual.get('Image') == request['Image']
         and labels.get('com.teamaibox.installation-id') == installation_id
         and all(labels.get(k) == v for k, v in request['Labels'].items()),
         'existing office container differs; not adopted or replaced: ' + name)
    need(actual['HostConfig']['RestartPolicy']['Name'] == 'no'
         and actual['HostConfig'].get('AutoRemove') is False,
         'office container lifecycle policy differs')


def create_stopped(root, runtime, installation_id, *, check=False, engine=docker):
    journal_path = root / 'office-container-creation.json'
    journal = read_json(journal_path) if journal_path.exists() else dict(installationId=installation_id, workers={})
    need(journal['installationId'] == installation_id, 'worker creation installation differs')
    result = []
    # Validate all names, images and preexisting containers BEFORE creating any.
    pending = []
    for role, p in runtime['profiles'].items():
        request = deepcopy(runtime['createRequests'][role])
        name = 'teamaibox-worker-' + p['workerId']
        need(request['Labels']['com.teamaibox.installation-id'] == installation_id,
             'worker declaration belongs to another installation')
        sha = request_digest(request)
        request['Labels']['com.teamaibox.factory-request-sha256'] = sha
        previous = journal['workers'].get(role)
        need(previous is None or previous['name'] == name and previous['requestSha256'] == sha,
             'worker creation declaration changed; existing data preserved')
        status, image = engine('GET', '/images/' + quote(request['Image'], safe='') + '/json')
        need(status == 200 and image['Id'] == request['Image']
             and image['Architecture'] == 'arm64' and image['Os'] == 'linux', 'office image not imported: ' + role)
        status, current = engine('GET', '/containers/' + name + '/json')
        need(status in (200, 404), 'cannot inspect office container: ' + role)
        if status == 200:
            need(previous is not None, 'unregistered existing office container preserved: ' + role)
            owned_container(current, request, installation_id, name)
            if previous.get('containerId'):
                need(current['Id'] == previous['containerId'], 'office container was replaced outside installer')
            if previous.get('entry'):
                validate_identity(current, previous['entry'])
        else:
            need(not check, 'office container not created: ' + role)
            need(not previous or not previous.get('containerId'), 'registered office container missing; not recreated')
        pending.append((role, name, request, sha, current if status == 200 else None))
    for role, name, request, sha, current in pending:
        if current is None:
            # Journal intent before Docker; a lost response can be reconciled
            # by exact generated name + installation + request digest.
            journal['workers'][role] = dict(name=name, requestSha256=sha)
            write_json(journal_path, journal)
            status, _ = engine('POST', '/containers/create?name=' + name, request)
            need(status == 201, 'office container creation failed: ' + role)
            status, current = engine('GET', '/containers/' + name + '/json')
            need(status == 200, 'new office container could not be inspected: ' + role)
            owned_container(current, request, installation_id, name)
            need(not current['State']['Running'], 'new office worker unexpectedly running')
        entry = dict(id=current['Id'], name=name, image=current['Image'],
                     configurationSha256=configuration_digest(current),
                     memoryLimitBytes=current['HostConfig']['Memory'])
        result.append(entry)
        if not check:
            journal['workers'][role] = dict(name=name, requestSha256=sha, containerId=current['Id'], entry=entry)
            write_json(journal_path, journal)
    return dict(schemaVersion=2, containers=result)


def immutable_json(path, value, check=False):
    if path.exists():
        need(read_json(path) == value, 'existing recovery input differs: ' + path.name)
    else:
        need(not check, 'recovery input missing: ' + path.name)
        write_json(path, value)


def apply(root, check=False, *, engine=docker):
    from appliance_installation import load, resolve, save
    record = load(root / 'installation.json')
    state = read_json(root / 'install-state.json')
    need(record['installationId'] == state['installationId'], 'installation identity differs')
    runtime = read_json(Path(record['references']['officeRuntime']))
    media = resolve(record, 'casting-media')
    need(media['Config']['Labels'].get('com.teamaibox.installation-id') == state['installationId'],
         'media container belongs to another installation')
    manifest = create_stopped(root, runtime, state['installationId'], check=check, engine=engine)
    manifest_path, boot_path = root / 'config/office-manifest.json', root / 'config/office-boot.json'
    immutable_json(manifest_path, manifest, check)
    raw = manifest_path.read_bytes()
    models = [dict(workerId=p['workerId'], containerId=e['id'], declaredResidentBytes=p['declaredResidentBytes'])
              for p, e in zip(runtime['profiles'].values(), manifest['containers'])]
    boot = dict(schemaVersion=2, nodeId=record['nodeId'], baseManifestSha256=hashlib.sha256(raw).hexdigest(),
                models=models, independentMediaContainerId=media['Id'])
    from restore_calibrated_office_workers import validate_configuration
    validate_configuration(boot, manifest, raw)
    immutable_json(boot_path, boot, check)
    expected = {'officeManifest': str(manifest_path), 'officeBoot': str(boot_path)}
    if check:
        need(all(record['references'].get(k) == v for k, v in expected.items()), 'office recovery binding missing')
    else:
        for k, v in expected.items():
            need(k not in record['references'] or record['references'][k] == v, 'office recovery binding conflict')
        record['references'].update(expected)
        save(root / 'installation.json', record)
        save('/etc/teamaibox/installation.json', record)
    return dict(status='checked' if check else 'created-stopped', count=len(models), modelsStarted=False)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installation-root', type=Path, required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    need(os.geteuid() == 0, 'root required')
    print(json.dumps(apply(args.installation_root.resolve(), args.check)))

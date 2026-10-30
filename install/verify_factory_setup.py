#!/usr/bin/env python3
"""Check factory API setup with new isolated DB/bus containers, no host services.

This validates the foundation/first-owner entry, not model or guest startup.
Only exact local images and this checkout's source are used. No host ports,
Docker socket, GPU, customer mounts or host installation records are accessed.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import time
import uuid

from factory_bootstrap import expand
from factory_core import core_templates
from factory_guests import configurations
from factory_identity import install_tls_copies, secret_file, tls_identity
from offline_common import digest, need, read_json, run, write_json


def verify(repository, output, images):
    repository, output = repository.resolve(strict=True), output.absolute()
    need(not output.exists() and not any(p.is_symlink() for p in (output, *output.parents)),
         'choose a new isolated verification directory')
    for role, image in images.items():
        actual = json.loads(run(['docker', 'image', 'inspect', image]))[0]
        need(actual['Id'] == image and actual['Os'] == 'linux' and actual['Architecture'] == 'arm64',
             'exact local ARM64 image required: ' + role)
    output.mkdir(parents=True, mode=0o755)
    identity, node_id = str(uuid.uuid4()), str(uuid.uuid4())
    project = 'teamaibox-factory-setup-' + identity[:8]
    compose, secrets, directories = core_templates(repository)
    for row in secrets:
        secret_file(row, output)
    tls_identity(output / 'identity', node_id, identity)
    copies = [dict(source=n + '.crt', path='public/' + n + '.crt') for n in ('ca', 'node', 'scheduler')]
    copies.append(dict(source='scheduler.key', path='secrets/scheduler.key', mode='0440', gid=10001))
    install_tls_copies(copies, output / 'identity', output)
    write_json(output / 'public/appliance-addresses.json', dict(addresses=[], dnsNames=[]), 0o644)
    write_json(output / 'public/ai-startup.json', dict(schemaVersion=1, nodeId=node_id, status='pending', workers={}), 0o644)
    write_json(output / 'public/plugin-routes.json', read_json(repository / 'deploy/appliance/plugin-routes.json'), 0o644)
    write_json(output / 'config/built-in-applications.json', read_json(repository / 'deploy/applications/built-in-applications.v1.json'), 0o644)
    image = images['platform-api']
    guest_release = dict(images=[dict(role=r, imageId=image) for r in ('phone-runtime', 'phone-google-runtime', 'computer-runtime')],
        assets=[dict(role=r, destination='assets/' + r, files=[dict(path=f, sha256='a' * 64) for f in files])
                for r, files in [('computer-firmware', ['CODE.fd', 'VARS.fd']), ('computer-drivers', ['virtio.iso'])]],
        guestSystems=dict(androidVersion='17', androidBaseBuildId='16102939', cameraSources=['image', 'browser', 'video']),
        host=dict(freeReserveBytes=0))
    guests = configurations(output, dict(nodeId=node_id), guest_release, 'pool-' + identity,
                            groups=[[0, 1]], kvm_group=108, vhost_group=108)
    tokens = set(re.findall(r'@@([A-Za-z0-9_.-]+)@@', json.dumps(compose)))
    values = dict(ROOT=str(output), DATA=str(output / 'data'), RUNTIME=str(repository), INSTALLATION_ID=identity,
        NODE_ID=node_id, RELEASE_ID='installation-setup-validation', DOCKER_GID=987, KVM_GID=108,
        CONFIGURATION_DIGEST='sha256:' + 'b' * 64)
    values.update({v: images.get(v.split('.', 1)[1], image) for v in tokens if v.startswith('IMAGE.')})
    values.update({v: project + '-' + v.split('.', 1)[1] for v in tokens if v.startswith('NETWORK_NAME.')})
    values.update({v: json.dumps(guests[v.split('.', 1)[1]]) for v in tokens if v.startswith('GUEST_JSON.')})
    values.update({v: 'false' for v in tokens if v.startswith('CAMERA.')})
    compose = expand(compose, values)
    compose['services'] = {k: v for k, v in compose['services'].items()
                           if k in ('postgres', 'database-migrate', 'event-bus', 'object-service', 'messaging', 'platform-api')}
    used_volumes = set()
    for name, service in compose['services'].items():
        service['restart'] = 'no'
        service['labels'] = {'com.teamaibox.installation-test': identity}
        service['networks'] = ['isolated']
        service.pop('ports', None)
        service['healthcheck'] = dict(service.get('healthcheck', {}), interval='1s', start_period='2s', retries=30)
        if name == 'database-migrate':
            service.pop('healthcheck')
            service.setdefault('volumes', []).append(dict(type='bind', source=str(repository / 'packages/persistence/migrations'),
                target='/opt/teamaibox/migrations', read_only=True))
            service['environment']['TEAMAIBOX_MIGRATION_MANIFEST_SHA256'] = digest(repository / 'packages/persistence/migrations/manifest.json')
        for volume in service.get('volumes', []):
            if isinstance(volume, str):
                used_volumes.add(volume.split(':')[0])
    compose['networks'] = {'isolated': dict(internal=True, labels={'com.teamaibox.installation-test': identity})}
    compose['volumes'] = {k: v for k, v in compose['volumes'].items() if k in used_volumes}
    for name, volume in compose['volumes'].items():
        path = Path(volume['driver_opts']['device'])
        need(path.is_relative_to(output / 'data'), 'test data path escaped')
        row = next(d for d in directories if d['path'] == path.relative_to(output / 'data').as_posix())
        path.mkdir(parents=True, mode=0o755)
        os.chown(path, row['uid'], row['gid'])
        os.chmod(path, int(row['mode'], 8))
        volume['name'] = project + '-' + name
        volume['labels'] = {'com.teamaibox.installation-test': identity}
    api = compose['services']['platform-api']
    # Verify current source without modifying/rebuilding any deployed image.
    for name in ('apps/platform-api/server', 'apps/platform-api/src', 'packages/persistence/src',
                 'packages/authorization/src', 'packages/observability/src', 'packages/secrets/src'):
        api['volumes'].append(dict(type='bind', source=str(repository / name), target='/opt/teamaibox/' + name, read_only=True))
    for path in (repository / 'services').iterdir():
        if path.is_dir():
            for section in ('src', 'server'):
                if (path / section).is_dir():
                    name = 'services/' + path.name + '/' + section
                    api['volumes'].append(dict(type='bind', source=str(repository / name), target='/opt/teamaibox/' + name, read_only=True))
    write_json(output / 'compose.json', compose, 0o600)
    command = ['docker', 'compose', '-p', project, '-f', output / 'compose.json']
    run([*command, 'config', '--quiet'])
    report = dict(testId=identity, status='incomplete', scope='factory-foundation-setup', network='internal-no-public-ports',
                  customerDataAccessed=False, gpuUsed=False, modelReadinessValidated=False, guestRuntimeValidated=False, images=images)
    try:
        run([*command, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '90'], timeout=110)
        cid = run([*command, 'ps', '-q', 'platform-api']).strip()
        script = "fetch('http://127.0.0.1:8080/api/setup/status',{headers:{'x-forwarded-proto':'https'}}).then(async r=>{if(!r.ok)throw Error(String(r.status)); console.log(JSON.stringify(await r.json()))}).catch(e=>{console.error(e.message);process.exit(1)})"
        status = json.loads(run(['docker', 'exec', cid, 'node', '-e', script]))
        need(status.get('required') is True and status.get('claimProtected') is True, 'fresh API did not offer protected owner setup')
        owner_source = (repository / 'install/factory_owner.mjs').read_text()
        owner_source += """
const codes = Array.from({length:8}, () => 'taib-recovery-' + randomBytes(24).toString('base64url'));
const first = await main({recoveryCodes:codes});
if (first.status !== 'created' || first.loginName !== 'admin') throw Error('default owner not created');
const headers = {'x-forwarded-proto':'https',origin:'https://teamaibox.local','content-type':'application/json'};
const request = async (path, body) => fetch('http://127.0.0.1:8080' + path,
  {headers, ...(body ? {method:'POST',body:JSON.stringify(body)} : {})});
const login = await request('/api/auth/sign-in', {loginName:'admin',password:'admin'});
const session = await login.json();
if (!login.ok || session.identity?.loginName !== 'admin' || !session.identity.roles.includes('owner')) throw Error('default sign-in failed');
const status = await (await request('/api/setup/status')).json();
if (status.required) throw Error('setup still required');
const {createPostgresDatabaseFromEnvironment} = await import('./packages/persistence/src/postgres-database.mjs');
const {PostgresIdentityRepository} = await import('./apps/platform-api/src/identity/postgres-repository.mjs');
const {PasswordHasher} = await import('./apps/platform-api/src/identity/password.mjs');
const db = await createPostgresDatabaseFromEnvironment();
const changed = 'temporary acceptance passphrase';
try {
  const repository = new PostgresIdentityRepository({database:db});
  await repository.resetIdentityPassword(first.ownerIdentityId, await new PasswordHasher().hash(changed), new Date());
  const before = await repository.findByNormalizedLogin('admin');
  const again = await main({});
  const checked = await main({check:true});
  const after = await repository.findByNormalizedLogin('admin');
  if (again.status !== 'preserved' || checked.status !== 'preserved'
    || before.passwordHash !== after.passwordHash || before.passwordVersion !== after.passwordVersion) throw Error('rerun changed owner');
  const changedLogin = await request('/api/auth/sign-in', {loginName:'admin',password:changed});
  if (!changedLogin.ok) throw Error('changed password not preserved');
  const oldLogin = await request('/api/auth/sign-in', {loginName:'admin',password:'admin'});
  if (oldLogin.status !== 401) throw Error('old password still works');
  console.log(JSON.stringify({defaultOwnerLogin:true,setupRequired:false,changedPasswordPreserved:true,
    rerunCreatedUsers:again.usersCreated,checkCreatedUsers:checked.usersCreated}));
} finally {await db.close();}
"""
        acceptance = subprocess.run(['docker', 'exec', '-i', '--workdir', '/opt/teamaibox', cid,
                                     'node', '--input-type=module'], input=owner_source,
                                    capture_output=True, text=True, timeout=60)
        need(acceptance.returncode == 0, 'default administrator acceptance failed: ' + acceptance.stderr[-1000:])
        report.update(status='passed', setupStatus=status, defaultAdministrator=json.loads(acceptance.stdout))
    finally:
        # Only this random project; never touch existing product containers or volumes.
        ids = run(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project]).split()
        for cid in ids:
            actual = json.loads(run(['docker', 'inspect', cid]))[0]
            need(actual['Config']['Labels'].get('com.teamaibox.installation-test') == identity, 'test ownership changed')
        if report['status'] != 'passed':
            # Startup messages only, not environment/credential dumps.
            logs = run([*command, 'logs', '--no-color', '--tail', '30'])
            (output / 'startup.log').write_text(logs)
            (output / 'startup.log').chmod(0o600)
        run([*command, 'down', '--volumes', '--timeout', '10'], timeout=90)
        report['temporaryResourcesRemoved'] = True
        write_json(output / 'report.json', report, 0o644)
    return report


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--repository', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    for name in ('postgres', 'event-bus', 'platform-api'):
        p.add_argument('--' + name + '-image', required=True)
    a = p.parse_args()
    need(os.geteuid() == 0, 'root required for isolated permission checks')
    print(json.dumps(verify(a.repository, a.output, {r: getattr(a, r.replace('-', '_') + '_image')
                     for r in ('postgres', 'event-bus', 'platform-api')}), indent=2))

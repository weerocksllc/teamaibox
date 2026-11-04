#!/usr/bin/env python3
"""Repair only registered, running API sidecars stranded in an old netns.

Docker's container:<id> string can remain correct after the owner restarts,
while a running sidecar still holds the old Linux network namespace. Compare
live namespace inodes, not just Docker configuration or process health.
Never restart the owner, guests, workers, independent services or stopped
sidecars. Replaced container identities must be reconciled by the upgrade
transaction, not adopted by this recovery adapter.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import time
import uuid

from appliance_installation import load, resolve

SIDECARS = ('appliance-gateway', 'desktop-proxy', 'desktop-gateway',
            'maintenance-controller', 'node-agent')


class Docker:
    monotonic = staticmethod(time.monotonic)
    sleep = staticmethod(time.sleep)

    def resolve(self, record, role):
        return resolve(record, role)

    def namespace(self, container):
        state = container['State']
        if not state['Running'] or state.get('Restarting') or state.get('Paused'):
            raise RuntimeError('namespace_service_not_running')
        return os.readlink('/proc/%s/ns/net' % state['Pid'])

    def restart(self, container):
        subprocess.run(['docker', 'restart', '--time', '20', container['Id']],
                       check=True, capture_output=True, timeout=60)

    def control_ready(self, record, gateway):
        # A GET, not an artificial heartbeat: prove the gateway can reach API
        # and the real agent is reporting through mTLS in the other direction.
        js = """const u=new URL(process.env.APPLIANCE_PLATFORM_ORIGIN);
if(u.protocol!=='http:' || u.hostname!=='127.0.0.1' || u.port!=='8080')process.exit(1);
fetch(new URL('/health/ready',u),{signal:AbortSignal.timeout(3000)})
.then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1));"""
        probe = subprocess.run(['docker', 'exec', gateway['Id'], 'node', '-e', js],
                               capture_output=True, timeout=8)
        if probe.returncode:
            return False
        postgres = self.resolve(record, 'postgres')
        node = str(uuid.UUID(record['nodeId']))
        sql = ("SELECT EXISTS(SELECT 1 FROM compute.nodes WHERE id='" + node + "' "
               "AND lifecycle_state='ready' AND last_seen_at > now()-interval '45 seconds') "
               "AND EXISTS(SELECT 1 FROM compute.node_metric_snapshots WHERE node_id='" + node + "' "
               "AND received_at > now()-interval '60 seconds');")
        result = subprocess.run(['docker', 'exec', '-i', postgres['Id'], 'sh', '-c',
                                 'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'],
                                input=sql, text=True, capture_output=True, timeout=10)
        return result.returncode == 0 and result.stdout.strip() == 't'


def owner_token(docker, container):
    return (container['Id'], container['State']['StartedAt'], docker.namespace(container))


def recover(record, docker, *, check=False, timeout=120):
    # Validate all registered identities before any mutation, including the DB
    # used by the read-only end-to-end health check.
    parent = docker.resolve(record, 'platform-api')
    token = owner_token(docker, parent)
    if parent['State'].get('Health', {}).get('Status') != 'healthy':
        raise RuntimeError('namespace_owner_not_ready')
    docker.resolve(record, 'postgres')
    rows = {role: docker.resolve(record, role) for role in SIDECARS if role in record['services']}
    shared = {}
    for role, row in rows.items():
        mode = row['HostConfig']['NetworkMode']
        if not mode.startswith('container:'):
            continue  # Independently networked installations are not migrated.
        if mode not in ('container:' + parent['Id'], 'container:' + parent['Name'].lstrip('/')):
            raise RuntimeError('namespace_binding_changed:' + role)
        docker.namespace(row)  # Do not start intentionally stopped services.
        shared[role] = row
    drift = [role for role, row in shared.items() if docker.namespace(row) != token[2]]
    if shared and ('appliance-gateway' not in shared or 'node-agent' not in shared):
        raise RuntimeError('namespace_control_cohort_incomplete')
    if check and drift:
        raise RuntimeError('namespace_disconnected:' + ','.join(drift))
    restarted = []
    for role in drift:
        if owner_token(docker, docker.resolve(record, 'platform-api')) != token:
            raise RuntimeError('namespace_owner_changed_during_recovery')
        row = docker.resolve(record, role)
        if row['HostConfig']['NetworkMode'] != shared[role]['HostConfig']['NetworkMode']:
            raise RuntimeError('namespace_binding_changed:' + role)
        if docker.namespace(row) == token[2]:
            continue
        docker.restart(row)
        restarted.append(role)
        deadline = docker.monotonic() + timeout
        while True:
            if owner_token(docker, docker.resolve(record, 'platform-api')) != token:
                raise RuntimeError('namespace_owner_changed_during_recovery')
            row = docker.resolve(record, role)
            if docker.namespace(row) != token[2]:
                raise RuntimeError('namespace_rejoin_failed:' + role)
            if row['State'].get('Health', {}).get('Status') == 'healthy':
                break
            if docker.monotonic() >= deadline:
                raise RuntimeError('namespace_sidecar_readiness_timeout:' + role)
            docker.sleep(2)
    # Always check the full path, even when all container health checks pass.
    # Transport failures in a matching namespace are reported, not treated as
    # permission to restart arbitrary services or enter a restart loop.
    if shared:
        deadline = docker.monotonic() + (timeout if restarted and not check else 0)
        while not docker.control_ready(record, docker.resolve(record, 'appliance-gateway')):
            if docker.monotonic() >= deadline:
                raise RuntimeError('namespace_control_path_not_ready')
            docker.sleep(3)
    if owner_token(docker, docker.resolve(record, 'platform-api')) != token:
        raise RuntimeError('namespace_owner_changed_during_recovery')
    for role in shared:
        if docker.namespace(docker.resolve(record, role)) != token[2]:
            raise RuntimeError('namespace_disconnected:' + role)
    return dict(status='ready', restarted=restarted, checked=list(shared), controlPathChecked=bool(shared))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installation', type=Path, default=Path('/etc/teamaibox/installation.json'))
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise PermissionError('root_required')
    record = load(args.installation)
    # One host-side adapter instance, independent of the broken network itself.
    lock = Path('/run/teamaibox-namespace-' + str(uuid.UUID(record['installationId'])) + '.lock')
    with lock.open('a') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(recover(record, Docker(), check=args.check)))


if __name__ == '__main__':
    main()

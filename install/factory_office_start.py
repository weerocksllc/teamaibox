#!/usr/bin/env python3
"""Load this installation's exact workers through existing boot recovery."""
import argparse
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from offline_common import need, read_json, run, write_json


def host_memory(text):
    memory = {line.split(':', 1)[0]: int(line.split()[1]) * 1024
              for line in text.splitlines() if line.startswith(('MemTotal:', 'MemAvailable:'))}
    need(0 < memory.get('MemAvailable', 0) <= memory.get('MemTotal', 0),
         'host memory observation is incomplete')
    # Old, inactive swapped pages do not mean current memory pressure. The
    # coordinator evaluates actual available memory and current worker usage.
    # Never demand swapoff or restart a healthy host to get an empty counter.
    return memory


def resident_memory(memory):
    """Resident working set, not reclaimable installation/model file cache.

    Match the existing per-container pressure metric: current - inactive_file.
    The separate host/admission snapshot below still charges full current bytes;
    this must never manufacture free host memory or reduce reservations.
    """
    current, inactive = memory['current'], memory.get('inactiveFile', 0)
    need(type(current) is int and type(inactive) is int and 0 <= inactive < current,
         'worker memory observation is incomplete or inconsistent')
    return current - inactive


def capture(root):
    from appliance_installation import load, resolve
    from boot_container_memory import memory_row, container_memory_rows
    from restore_existing_office_workers import inspect, manifest
    from factory_database import query
    runtime = read_json(root / 'config/office-runtime.json')
    record = load(root / 'installation.json')
    stamp = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    workers = []
    entries = manifest(Path(record['references']['officeManifest']))
    for p, entry in zip(runtime['profiles'].values(), entries):
        c = inspect(entry)
        need(c['Config']['Labels']['com.teamaibox.installation-id'] == record['installationId']
             and c['State']['Running'] and c['State']['Health']['Status'] == 'healthy'
             and not c['State']['OOMKilled'], 'office worker is not healthy: ' + entry['name'])
        memory = memory_row(c)
        need(not memory['oomKill'], 'new worker has an OOM event')
        workers.append({**p, 'state': 'running', 'healthy': True, 'containerId': c['Id'],
                        'startedAt': c['State']['StartedAt'], 'residentBytes': resident_memory(memory)})
    core_healthy = True
    for role in ('platform-api', 'postgres', 'web', 'node-agent'):
        c = resolve(record, role)
        core_healthy &= c['State']['Running'] and c['State'].get('Health', {}).get('Status') == 'healthy'
    # This path is only for installing a new set, not maintaining an appliance
    # with guests/jobs. Refuse rather than omit their resource reservations.
    counts = query(root, "SELECT (SELECT count(*) FROM platform.phones)+(SELECT count(*) FROM platform.computers)+"
        "(SELECT count(*) FROM compute.lease_sets WHERE state='active' AND expires_at>clock_timestamp())+"
        "(SELECT count(*) FROM compute.cast_resource_reservations WHERE state='active');")
    need(counts == '0', 'finish installation before creating phones, computers or active jobs')
    mem = host_memory(Path('/proc/meminfo').read_text())
    identities = {w['containerId']: w['workerId'] for w in workers}
    # Also charge non-office containers. The conservative core reserve remains
    # intact; a media/helper process must not disappear from accounting.
    rows = container_memory_rows(run)
    need(set(identities).issubset({r['id'] for r in rows}), 'office worker disappeared during memory capture')
    snapshot = dict(observedAt=stamp, host=dict(observedAt=stamp, totalBytes=mem['MemTotal'], availableBytes=mem['MemAvailable']),
                    workers=[dict(workerId=identities.get(r['id'], 'container:' + r['id']),
                                  cgroup=dict(currentBytes=r['current'])) for r in rows],
                    activeReservations=[])
    return dict(schemaVersion=1, installationId=record['installationId'], nodeId=record['nodeId'],
                setId=runtime['setId'], profiles=list(runtime['profiles'].values()), workers=workers,
                observedAt=stamp, coreHealthy=bool(core_healthy), memorySnapshot=snapshot)


def apply(root, check=False):
    from appliance_installation import load, resolve
    from factory_database import query
    from factory_guest_catalog import sql_value
    record = load(root / 'installation.json')
    units = read_json(root / 'recovery-units.json')
    need(units['installationId'] == record['installationId'], 'office recovery unit does not belong to installation')
    if check:
        # A completed installation may contain user guests. Do not restart
        # workers, rerun admission or rewrite metadata on a same-package check.
        from restore_existing_office_workers import inspect, manifest
        for entry in manifest(Path(record['references']['officeManifest'])):
            c = inspect(entry)
            need(c['State']['Running'] and c['State'].get('Health', {}).get('Status') == 'healthy',
                 'office worker is not ready: ' + entry['name'])
        runtime = read_json(root / 'config/office-runtime.json')
        status = query(root, 'SELECT recovery_state FROM compute.protected_office_sets WHERE set_id=' +
                       sql_value(runtime['setId']) + ' AND node_id=' + sql_value(record['nodeId']) + ';')
        need(status == 'healthy', 'office catalog has not been committed')
        return dict(status='checked', modelsRestarted=False)
    # The existing v3 boot service handles one failed model independently and
    # retains healthy workers and persistent compilation caches.
    run(['systemctl', 'start', 'teamaibox-existing-office-workers.service'], timeout=7200)
    observed = capture(root)
    api = resolve(record, 'platform-api')
    need(api['Config']['Labels']['com.teamaibox.installation-id'] == record['installationId'], 'API ownership differs')
    source = (root / 'runtime/install/factory_office_ready.mjs').read_text()
    source += "\nlet raw='';for await(const part of process.stdin)raw+=part;console.log(JSON.stringify(await main(JSON.parse(raw))));\n"
    result = subprocess.run(['docker', 'exec', '-i', api['Id'], 'node', '--input-type=module', '-e', source],
        input=json.dumps(observed), capture_output=True, text=True, timeout=60)
    need(result.returncode == 0, 'fresh office catalog readiness commit failed; healthy models were not restarted')
    report = json.loads(result.stdout)
    write_json(root / 'office-first-start.json', report)
    return report


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--installation-root', type=Path, required=True)
    p.add_argument('--check', action='store_true')
    args = p.parse_args()
    need(os.geteuid() == 0, 'root required')
    print(json.dumps(apply(args.installation_root.resolve(), args.check)))

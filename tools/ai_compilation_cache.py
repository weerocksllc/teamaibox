#!/usr/bin/env python3
"""Reversible cache-only migration of the installed AI model containers.

No weights, guest volumes or engine arguments are changed. Full container
configuration is saved only in the root-owned maintenance directory.
"""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import quote
from deploy_product_copy_20261022 import api, inspect, run, need, write_json, endpoint
import restore_existing_office_workers as legacy
import restore_calibrated_office_workers as boot
import ai_cache_checkpoint as checkpoint

LABEL = 'org.teamaibox.compilation-cache'


def cache_plan(container):
    env = dict(item.split('=', 1) for item in container['Config'].get('Env', []) if '=' in item)
    paths = [env[key] for key in ('VLLM_CACHE_ROOT', 'TORCHINDUCTOR_CACHE_DIR', 'TRITON_CACHE_DIR', 'CUDA_CACHE_PATH')
             if env.get(key, '').startswith('/tmp/')]
    if not paths:
        return []  # ASR has no compiler; FLUX already uses its persistent offload volume.
    home = env.get('HOME', '/tmp')
    # Persist the cache root as a whole: mounting only its vllm child makes
    # Docker create a root-owned parent on fresh tmpfs. Non-root engines must
    # also be able to create sibling caches such as FlashInfer there.
    cache_root = env.get('XDG_CACHE_HOME', home + '/.cache')
    paths += [cache_root, env.get('VLLM_CACHE_ROOT', cache_root + '/vllm'),
              home + '/.triton/cache', home + '/.nv/ComputeCache']
    paths = sorted(set(path for path in paths if path.startswith('/tmp/')))
    for path in paths:
        need('..' not in Path(path).parts and path != '/tmp/', 'invalid_cache_path')
    # Avoid overlapping parent/child mounts.
    paths = [p for p in paths if not any(p.startswith(other + '/') for other in paths if other != p)]
    result = []
    for path in paths:
        identity = json.dumps([container['Image'], container['Config']['Labels'].get('com.teamaibox.worker-id'),
            container['Config']['Labels'].get('com.teamaibox.config-digest'),
            container['Config']['Labels'].get('com.teamaibox.start-spec-digest'), path], separators=(',', ':'))
        name = 'teamaibox-compile-' + hashlib.sha256(identity.encode()).hexdigest()[:32]
        result.append(dict(Type='volume', Source=name, Target=path, ReadOnly=False,
                           VolumeOptions={'NoCopy': True}))
    return result


def cached_payload(old, plan):
    payload = copy.deepcopy(old['Config'])
    host = copy.deepcopy(old['HostConfig'])
    targets = {m['Target'] for m in plan}
    need(not any(m['Destination'] in targets for m in old['Mounts']), 'cache_already_mounted')
    host['Mounts'] = [*host.get('Mounts', []), *plan]
    payload.update(HostConfig=host, Labels={**(payload.get('Labels') or {}), LABEL: 'persistent-v1'})
    payload['NetworkingConfig'] = {'EndpointsConfig': {n: endpoint(ep) for n, ep in old['NetworkSettings']['Networks'].items()}}
    return payload


def verify_preserved(old, current, plan):
    expected_config = copy.deepcopy(old['Config'])
    expected_config['Labels'] = {**(expected_config.get('Labels') or {}), LABEL: 'persistent-v1'}
    need(current['Config'] == expected_config and current['Image'] == old['Image'], 'model_configuration_changed')
    expected_host = copy.deepcopy(old['HostConfig'])
    expected_host['Mounts'] = [*expected_host.get('Mounts', []), *copy.deepcopy(plan)]
    actual_host = copy.deepcopy(current['HostConfig'])
    for value in (expected_host, actual_host):
        for key in ('Dns', 'DnsOptions', 'DnsSearch'):
            if value.get(key) == []: value[key] = None
        for mount in value.get('Mounts', []):
            # Docker omits the default false field on inspection.
            mount.setdefault('ReadOnly', False)
    need(actual_host == expected_host, 'model_runtime_changed_beyond_cache')
    targets = {p['Target'] for p in plan}
    old_mounts = sorted(old['Mounts'], key=lambda m: m['Destination'])
    retained = sorted([m for m in current['Mounts'] if m['Destination'] not in targets], key=lambda m: m['Destination'])
    need(retained == old_mounts, 'model_data_mount_changed')


def wait_model(cid, timeout=900):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        current = inspect(cid)
        need(current['State']['Running'], 'model_exited_during_cache_migration')
        if current['State'].get('Health', {}).get('Status') == 'healthy': return current
        time.sleep(3)
    raise RuntimeError('cache_migration_model_health_timeout')


def seed(old, plan, stage):
    for index, mount in enumerate(plan):
        volume = api('POST', '/volumes/create', {'Name': mount['Source'], 'Labels': {LABEL: 'persistent-v1'}})
        target = Path(volume['Mountpoint'])
        need(target.name == '_data' and target.parent.name == mount['Source'] and target.is_dir(), 'unexpected_cache_volume')
        user = old['Config']['User'].split(':')
        need(user[0].isdigit() and (len(user) == 1 or user[1].isdigit()), 'numeric_model_user_required')
        os.chown(target, int(user[0]), int(user[-1])); target.chmod(0o700)
        present = subprocess.run(['docker', 'exec', old['Id'], 'test', '-d', mount['Target']], capture_output=True, timeout=10)
        if present.returncode == 0:
            destination = stage / ('seed-' + str(index)); destination.mkdir(mode=0o700)
            # Engine archive/cp cannot reliably see nested tmpfs contents. Read
            # from inside the running mount namespace; export only this cache.
            with subprocess.Popen(['docker','exec',old['Id'],'tar','-C',mount['Target'],'-cf','-','.'],
                                  stdout=subprocess.PIPE,stderr=subprocess.PIPE) as producer:
                extracted=subprocess.run(['tar','-xf','-','-C',str(destination)],stdin=producer.stdout,
                                         capture_output=True,timeout=300)
                producer.stdout.close()
                producer.wait(timeout=10)
                need(producer.returncode==0 and extracted.returncode==0,'compilation_cache_export_failed')
            run(['cp', '-a', '--reflink=auto', str(destination) + '/.', str(target)], 300)


def migrate_entry(entry, stage):
    old = legacy.inspect(entry)
    if old['Config']['Labels'].get(LABEL) == 'persistent-v1': return old
    plan = cache_plan(old)
    if not plan: return old
    need(old['State']['Running'] and old['State']['Health']['Status'] == 'healthy', 'model_not_ready_for_cache_migration')
    stage.mkdir(mode=0o700)
    write_json(stage / 'parent.json', old)
    write_json(stage / 'plan.json', plan)
    seed(old, plan, stage)
    payload = cached_payload(old, plan)
    cid = None
    name = old['Name'].lstrip('/')
    try:
        api('POST', '/containers/' + old['Id'] + '/stop?t=30')
        for network in old['NetworkSettings']['Networks']:
            api('POST', '/networks/' + quote(network, safe='') + '/disconnect', {'Container': old['Id']})
        cid = api('POST', '/containers/create?name=' + quote(name + '-cache-candidate'), payload)['Id']
        write_json(stage / 'candidate.json', {'id': cid})
        api('POST', '/containers/' + old['Id'] + '/rename?name=' + quote(name + '-pre-cache-' + old['Id'][:8]))
        api('POST', '/containers/' + cid + '/rename?name=' + quote(name))
        api('POST', '/containers/' + cid + '/start')
        boot.retain_gpu_access(inspect(cid))
        current = wait_model(cid)
        verify_preserved(old, current, plan)
        write_json(stage / 'result.json', dict(previous=old['Id'], current=cid, cacheMounts=plan,
                    imageUnchanged=True, dataMountsUnchanged=True, healthy=True))
        return current
    except Exception:
        rollback_entry(stage)
        raise


def rollback_entry(stage):
    old = json.loads((stage / 'parent.json').read_text())
    candidate_file = stage / 'candidate.json'
    if candidate_file.exists():
        cid = json.loads(candidate_file.read_text())['id']
        current = inspect(cid)
        need(current['Config']['Labels'].get(LABEL) == 'persistent-v1', 'wrong_cache_rollback_target')
        api('POST', '/containers/' + cid + '/stop?t=20')
        for network in current['NetworkSettings']['Networks']:
            api('POST', '/networks/' + quote(network, safe='') + '/disconnect', {'Container': cid})
        api('POST', '/containers/' + cid + '/rename?name=cache-reverted-' + cid[:16])
    if inspect(old['Id'])['Name'] != old['Name']:
        api('POST', '/containers/' + old['Id'] + '/rename?name=' + quote(old['Name'].lstrip('/')))
    for network, ep in old['NetworkSettings']['Networks'].items():
        if network not in inspect(old['Id'])['NetworkSettings']['Networks']:
            api('POST', '/networks/' + quote(network, safe='') + '/connect', {'Container': old['Id'], 'EndpointConfig': endpoint(ep)})
    api('POST', '/containers/' + old['Id'] + '/start')
    boot.retain_gpu_access(inspect(old['Id']))
    wait_model(old['Id'])


def migrate(configuration, manifest, stage):
    checkpoint.finish(configuration, manifest)
    value, entries = boot.load(configuration, manifest)
    original_config, original_manifest = configuration.read_bytes(), manifest.read_bytes()
    (stage / 'configuration.before.json').write_bytes(original_config)
    (stage / 'manifest.before.json').write_bytes(original_manifest)
    document = json.loads(original_manifest)
    changes = []
    for index, entry in enumerate(entries):
        current = migrate_entry(entry, stage / ('model-' + str(index)))
        if current['Id'] == entry['id']: continue
        document['containers'][index] = dict(entry, id=current['Id'], configurationSha256=legacy.configuration_digest(current))
        value['models'][index]['containerId'] = current['Id']
        manifest_bytes = (json.dumps(document, indent=2) + '\n').encode()
        value['baseManifestSha256'] = boot.digest(manifest_bytes)
        # Each successful model is committed independently; interruption never rolls back peers.
        # Durable journal makes the pair recoverable if power is lost between replacements.
        checkpoint.commit(configuration, manifest, value, document)
        changes.append(dict(previous=entry['id'], current=current['Id'], name=entry['name']))
        write_json(stage / 'changes.json', changes)
        print(json.dumps(dict(migrated=entry['name'], id=current['Id'])), flush=True)
    return changes


if __name__ == '__main__':
    configuration, manifest, stage = map(Path, sys.argv[1:])
    need(os.geteuid() == 0 and stage.is_dir() and stage.stat().st_mode & 0o077 == 0, 'private_root_stage_required')
    import fcntl
    with open('/run/lock/teamaibox-office-boot.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(dict(status='passed', changes=migrate(configuration, manifest, stage))))

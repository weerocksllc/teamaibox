#!/usr/bin/env python3
"""Fresh-appliance phase adapter for the release's clean factory recipe.

No live database/configuration export is accepted. All substitutions are local
identities, paths, content hashes and explicitly named release image IDs.
"""
from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from offline_common import InstallError, atomic, digest, need, read_json, run, validate_factory, within, write_json
from factory_identity import secret_file, tls_identity, install_tls_copies


TOKEN = re.compile(r'@@([A-Za-z0-9_.-]+)@@')


def pool_identity(installation_id):
    return 'pool-' + str(uuid.uuid5(uuid.UUID(installation_id), 'pool'))


def expand(value, substitutions):
    if isinstance(value, list):
        return [expand(v, substitutions) for v in value]
    if isinstance(value, dict):
        return {k: expand(v, substitutions) for k, v in value.items()}
    if isinstance(value, str):
        whole = TOKEN.fullmatch(value)
        if whole:
            need(whole[1] in substitutions, 'unknown factory token: ' + whole[1])
            return copy.deepcopy(substitutions[whole[1]])
        def replacement(match):
            need(match[1] in substitutions, 'unknown factory token: ' + match[1])
            return str(substitutions[match[1]])
        result = TOKEN.sub(replacement, value)
        need('@@' not in result, 'malformed factory token')
        return result
    return value


def create_factor(path, count=32):
    if path.exists():
        need(path.is_file() and not path.is_symlink() and path.stat().st_mode & 0o077 == 0,
             'existing factor permissions invalid')
        return
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(secrets.token_bytes(count))
        stream.flush()
        os.fsync(stream.fileno())


def storage(root, check=False):
    from restore_existing_business_volumes import restore
    record = root / 'storage-volumes.json'
    if record.exists():
        value = read_json(record)
        for volume in value['volumes']:
            restore(volume, check_only=check)
        storage_pool(root, value['volumes'], check)
        return
    need(not check, 'storage phase incomplete')
    state = read_json(root / 'install-state.json')
    provisioning = root / 'storage-create.json'
    volume_dir = root / 'volume'
    volume_dir.mkdir(mode=0o700, exist_ok=True)
    image, key, mount = volume_dir / 'data.img', volume_dir / 'automatic.key', root / 'data'
    pool_id = pool_identity(state['installationId'])
    # The existing phone/computer quota helper binds to this mapper identity.
    mapper = 'teamaibox-phone-' + pool_id
    if provisioning.exists():
        plan = read_json(provisioning)
        need(plan['installationId'] == state['installationId'] and plan['source'] == str(image), 'storage creation identity conflict')
        need(plan['stage'] in ('planned', 'formatting-luks', 'luks-ready', 'formatting-filesystem'),
             'unknown storage creation stage; no formatting attempted')
    else:
        need(not image.exists() and not key.exists() and not Path('/dev/mapper', mapper).exists(), 'unregistered storage preserved')
        need(not mount.exists() or not any(mount.iterdir()), 'nonempty data directory preserved')
        release = read_json(root / 'release.json')
        free = shutil.disk_usage(root).free
        image_bytes = (free - release['host']['freeReserveBytes']) // (1024 * 1024) * (1024 * 1024)
        need(image_bytes > sum(f['size'] for a in release['assets'] for f in a['files']) + 1024**3,
             'not enough physical space for encrypted data and required assets')
        plan = dict(installationId=state['installationId'], source=str(image), size=image_bytes,
                    luksUuid=str(uuid.uuid4()), fsUuid=str(uuid.uuid4()), stage='planned')
        write_json(provisioning, plan)
    create_factor(key, 64)
    need(key.stat().st_size == 64, 'storage factor shape mismatch')
    if not image.exists():
        fd = os.open(image, os.O_CREAT | os.O_EXCL | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            os.ftruncate(fd, plan['size'])
            os.fsync(fd)
        finally:
            os.close(fd)
    need(not image.is_symlink() and image.stat().st_size == plan['size'], 'storage file conflict')
    if plan['stage'] == 'planned':
        # A journal is persisted BEFORE formatting. An interrupted formatter is
        # never rerun blindly over an unidentifiable encrypted volume.
        plan['stage'] = 'formatting-luks'
        write_json(provisioning, plan)
        run(['cryptsetup', 'luksFormat', '--batch-mode', '--type', 'luks2', '--uuid', plan['luksUuid'],
             '--key-file', key, image], timeout=300)
    actual = run(['cryptsetup', 'luksUUID', image]).strip()
    need(actual == plan['luksUuid'], 'interrupted LUKS creation needs inspection; no automatic reformat')
    if plan['stage'] in ('planned', 'formatting-luks'):
        plan['stage'] = 'luks-ready'
        write_json(provisioning, plan)
    mapped = Path('/dev/mapper') / mapper
    if not mapped.exists():
        run(['cryptsetup', 'open', '--type', 'luks2', '--key-file', key, image, mapper])
    # Confirm this mapper refers to our registered backing file before mkfs.
    status = run(['cryptsetup', 'status', mapper])
    device = next((s.split(':', 1)[1].strip() for s in status.splitlines() if s.strip().startswith('device:')), '')
    loops = json.loads(run(['losetup', '-J', '--list', '--output', 'NAME,BACK-FILE', device]))
    need(len(loops['loopdevices']) == 1 and loops['loopdevices'][0]['back-file'] == str(image), 'mapper points to foreign storage')
    if plan['stage'] == 'luks-ready':
        plan['stage'] = 'formatting-filesystem'
        write_json(provisioning, plan)
        run(['mkfs.ext4', '-U', plan['fsUuid'], '-m', '0', '-O', 'project,quota',
             '-E', 'quotatype=prjquota,nodiscard', mapped], timeout=600)
    need(run(['blkid', '-s', 'UUID', '-o', 'value', mapped]).strip() == plan['fsUuid'],
         'interrupted filesystem creation needs inspection; no automatic reformat')
    mount.mkdir(mode=0o710, exist_ok=True)
    volume = dict(source=str(image), keyFile=str(key), mountPoint=str(mount), mapper=mapper,
                  kind='file', directIO=True, luksUuid=plan['luksUuid'], fsUuid=plan['fsUuid'], minimumSize=plan['size'], mountOptions='nodev,nosuid,prjquota')
    write_json(record, dict(version=1, volumes=[volume]))
    restore(volume)
    storage_pool(root, [volume])


def storage_pool(root, volumes, check=False):
    state = read_json(root / 'install-state.json')
    pool = pool_identity(state['installationId'])
    need(len(volumes) == 1 and volumes[0]['mapper'] == 'teamaibox-phone-' + pool
         and volumes[0]['mountPoint'] == str(root / 'data'), 'installation storage identity mismatch')
    volume = volumes[0]
    identity = dict(poolId=pool, luksUUID=volume['luksUuid'], filesystemUUID=volume['fsUuid'])
    path = within(root, 'data/pool.json')
    if path.exists():
        need(read_json(path) == identity, 'existing guest pool identity differs')
    else:
        need(not check, 'guest pool initialization incomplete')
        write_json(path, identity)
    directory = within(root, 'data/volumes')
    if check:
        need(directory.is_dir(), 'guest data directory missing')
    else:
        directory.mkdir(mode=0o710, exist_ok=True)
        # Agent binds this directory at the same absolute path. Keep it
        # readable/traversable for its dedicated group: the installed guest
        # storage adapter opens the directory to verify the pool identity.
        os.chown(root / 'data', 0, 10001)
        os.chmod(root / 'data', 0o750)
        os.chown(directory, 10001, 10001)


def factory(root):
    release = read_json(root / 'release.json')
    asset = next(v for v in release['assets'] if v['role'] == 'factory-configuration')
    directory = within(root / 'data', asset['destination'])
    recipe = read_json(directory / 'factory.json')
    validate_factory(recipe, {v['path'] for v in asset['files']}, release['runtimeFiles'])
    return directory, recipe


def configuration_receipt(root, recipe):
    """Bind immutable rendered files; dynamic addresses/status stay mutable."""
    return {row['output']: dict(sha256=digest(within(root, row['output'])),
            mode=within(root, row['output']).stat().st_mode & 0o777,
            uid=within(root, row['output']).stat().st_uid,
            gid=within(root, row['output']).stat().st_gid)
            for row in recipe['templates'] if not row.get('runtimeMutable', False)}


def check_configuration(root, recipe, state, record):
    need(record['installationId'] == state['installationId'] and record['nodeId'] == state['nodeId'], 'local identity mismatch')
    for row in recipe['templates']:
        need(within(root, row['output']).is_file(), 'rendered factory file missing: ' + row['output'])
    path = root / 'configuration-complete.json'
    need(path.is_file(), 'configuration incomplete')
    receipt = read_json(path)
    need(receipt.get('installationId') == state['installationId'] and
         receipt.get('files') == configuration_receipt(root, recipe),
         'installed configuration differs; preserved for inspection, not overwritten')
    for row in recipe['secrets']:
        # Check presence first: secret_file must never generate during --check.
        need(within(root, row['path']).is_file(), 'installed secret missing: ' + row['name'])
        secret_file(row, root)
    if 'officeDefinition' in recipe:
        token = within(root, 'secrets/drawing-provider-api')
        need(token.is_file() and token.read_bytes() == within(root, 'data/office/auth/drawing/provider.token').read_bytes()
             and token.stat().st_mode & 0o777 == 0o440 and token.stat().st_gid == 10001,
             'drawing API credential binding changed; preserved for inspection')


def variables(root, state, release):
    values = dict(ROOT=str(root), DATA=str(root / 'data'), INSTALLATION_ID=state['installationId'],
                  NODE_ID=state['nodeId'], RELEASE_ID=release['releaseId'], RUNTIME=str(root / 'runtime'))
    for row in release['images']:
        values['IMAGE.' + row['role']] = row['imageId']
    for row in release['assets']:
        values['ASSET.' + row['role']] = str(within(root / 'data', row['destination']))
    for key in ('assistant', 'drawing', 'ocr', 'asr', 'translation', 'embedding', 'pool'):
        values['ID.' + key] = str(uuid.uuid5(uuid.UUID(state['installationId']), key))
    values['ID.pool'] = pool_identity(state['installationId'])
    return values


def configuration(root, check=False):
    from appliance_networks import ENV, prepare
    from appliance_installation import load, save
    from appliance_https import initialize as https_init
    state, release = read_json(root / 'install-state.json'), read_json(root / 'release.json')
    directory, recipe = factory(root)
    target = root / 'installation.json'
    if check:
        record = load(target)
        check_configuration(root, recipe, state, record)
        return
    # A completed configuration is never silently regenerated by a later
    # failed phase. This also catches missing credentials without rotating them.
    if (root / 'configuration-complete.json').exists():
        check_configuration(root, recipe, state, load(target))
        return
    if target.exists():
        record = load(target)
        need(record['installationId'] == state['installationId'], 'installation identity conflict')
    else:
        record = dict(version=1, installationId=state['installationId'], nodeId=state['nodeId'], services={},
                      references={'installationRoot': str(root), 'storageVolumes': str(root / 'storage-volumes.json')},
                      networks={role: {'name': role if role != 'phone-control' else 'teamaibox-' + state['installationId'][:12] + '-phones',
                                       'internal': True} for role in ENV})
        save(target, record)
    record = prepare(record)
    save(target, record)
    vals = variables(root, state, release)
    vals['CONFIGURATION_DIGEST'] = 'sha256:' + hashlib.sha256(
        json.dumps(dict(recipe=recipe, releaseId=release['releaseId'], sourceCommit=release['sourceCommit'],
                        installationId=state['installationId']), sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    vals['DOCKER_GID'] = os.stat('/var/run/docker.sock').st_gid
    vals['KVM_GID'] = os.stat('/dev/kvm').st_gid
    if 'guestSystems' in release:
        from factory_guests import configurations, prepare_mountpoints
        # Factory kernels may ship vhost-vsock as an unloaded module. This is
        # an existing kernel capability, not a driver install or replacement.
        run(['modprobe', 'vhost_vsock'])
        prepare_mountpoints(root, release)
        guests = configurations(root, state, release, vals['ID.pool'])
        for kind in ('usb', 'udp'):
            vals['CAMERA.' + kind] = 'true' if kind in release['guestSystems']['cameraSources'] else 'false'
        guests['phones']['controlNetworkId'] = record['networks']['phone-control']['id']
        for name, value in guests.items():
            vals['GUEST.' + name] = value
            vals['GUEST_JSON.' + name] = json.dumps(value, separators=(',', ':'))
        pool = read_json(root / 'data/pool.json')
        vals['GUEST.storage'] = dict(pool, root=str(root / 'data'), clientUid=10001,
                                    computerOverheadBytes=512 * 1024**2,
                                    elasticBackingFile=str(root / 'volume/data.img'),
                                    elasticKeyFile=str(root / 'volume/automatic.key'))
    for role, env in ENV.items():
        vals[env] = record['networks'][role]['name']
        vals['NETWORK_ID.' + role] = record['networks'][role]['id']
        vals['NETWORK_NAME.' + role] = record['networks'][role]['name']
    if 'officeDefinition' in recipe:
        from factory_office import prepare as prepare_office
        office = prepare_office(root, read_json(within(directory, recipe['officeDefinition'])), state, release)
        vals.update({'OFFICE.runtime': office, 'OFFICE.policy': office['targetPolicy'],
                     'OFFICE_SET_ID': office['setId'], 'OFFICE_POLICY_DIGEST': office['targetPolicyDigest']})
        for role, profile in office['profiles'].items():
            vals['PROFILE_KEY.' + role] = profile['profileKey']
            vals['PROFILE_ID.' + role] = profile['modelProfileId']
        vals.update({'OFFICE_ENV.' + key: value for key, value in office['apiEnvironment'].items()})
        # Same generated provider credential, separately permissioned for API
        # and worker users. Never expose the worker's private directory to API.
        provider_token = within(root, 'data/office/auth/drawing/provider.token').read_bytes()
        api_token = within(root, 'secrets/drawing-provider-api')
        if api_token.exists():
            need(api_token.read_bytes() == provider_token, 'drawing credential binding differs')
        else:
            atomic(api_token, provider_token, 0o440)
            os.chown(api_token, 0, 10001)
    for row in recipe['directories']:
        path = within(root / 'data', row['path'])
        path.mkdir(parents=True, exist_ok=True, mode=int(row['mode'], 8))
        os.chown(path, row['uid'], row['gid'])
        os.chmod(path, int(row['mode'], 8))
    sockets = within(root, 'guest-runtime')
    sockets.mkdir(exist_ok=True, mode=0o750)
    os.chown(sockets, 0, 10001)
    os.chmod(sockets, 0o750)
    for row in recipe['secrets']:
        path = secret_file(row, root)
        vals['SECRET_PATH.' + row['name']] = str(path)
    if recipe.get('casting'):
        from factory_casting import declaration, boot
        binding_path = root / 'casting-binding.json'
        if binding_path.exists():
            binding = read_json(binding_path)
            need(binding['installationId'] == state['installationId'], 'casting binding identity differs')
        else:
            binding = declaration(record)
            write_json(binding_path, binding)
        casting = boot(root, binding)
        vals.update({'CASTING.' + k: v for k, v in casting.items() if k != 'environment'})
        vals['CASTING.declaration'] = binding
        vals.update({'CAST_ENV.' + k: v for k, v in casting['environment'].items()})
    if recipe.get('tlsCopies'):
        identity = root / 'internal-identity'
        tls_identity(identity, state['nodeId'], state['installationId'])
        install_tls_copies(recipe['tlsCopies'], identity, root)
        from factory_node import certificate_identity, inventory
        vals['NODE.identity'] = certificate_identity(identity / 'node.crt', state['nodeId'])
        vals['NODE.certificateFingerprint'] = vals['NODE.identity']['certificateFingerprint']
        casting_image = next(row['imageId'] for row in release['images'] if row['role'] == 'casting-media') if recipe.get('casting') else None
        vals['NODE.inventory'] = inventory(root / 'data', agent_version=release['agentVersion'], casting_image=casting_image)
    https_init(root / 'https', 1000)
    for row in recipe['templates']:
        source, dest = within(directory, row['input']), within(root, row['output'])
        need(not dest.exists() or not (root / 'configuration-complete.json').exists(),
             'configuration already completed; refusing to rewrite')
        value = expand(read_json(source), vals)
        if row['format'] == 'json':
            raw = (json.dumps(value, indent=2) + '\n').encode()
        elif row['format'] == 'env':
            need(all(isinstance(v, (str, int)) and '\n' not in str(v) for v in value.values()), 'invalid env value')
            raw = ('\n'.join(k + '=' + "'" + str(v).replace("'", "\\'") + "'" for k, v in value.items()) + '\n').encode()
        else:
            raise InstallError('unsupported template format')
        atomic(dest, raw, int(row.get('mode', '0600'), 8))
        os.chown(dest, row.get('uid', 0), row.get('gid', 0))
    from factory_core import validate_compose
    validate_compose(read_json(within(root, recipe['composeFile'])), [row['imageId'] for row in release['images']])
    record['references'].update({k: str(within(root, v)) for k, v in recipe['references'].items()})
    save(target, record)
    record_file = Path('/etc/teamaibox/installation.json')
    if record_file.exists():
        need(load(record_file)['installationId'] == state['installationId'], 'existing global installation conflict')
    save(record_file, record)
    write_json(root / 'configuration-complete.json', {'installationId': state['installationId'],
                                                     'files': configuration_receipt(root, recipe)})


def compose(root, recipe):
    record = read_json(root / 'installation.json')
    return ['docker', 'compose', '--project-name', 'teamaibox-' + record['installationId'][:12],
            '--env-file', within(root, recipe['composeEnvironment']), '-f', within(root, recipe['composeFile'])]


def services(root, phase, check=False):
    from appliance_installation import ROLES, service_record, save
    _, recipe = factory(root)
    definition = recipe['services'][phase]
    args = compose(root, recipe)
    if not check:
        # Release recipe must stage only named services; no down/remove/recreate.
        run([*args, 'up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout',
             str(definition['timeoutSeconds']), *definition['names']], timeout=definition['timeoutSeconds'] + 60)
    record = read_json(root / 'installation.json')
    for role, name in definition['roles'].items():
        ids = run([*args, 'ps', '-q', name]).split()
        need(len(ids) == 1, 'service not uniquely ready: ' + role)
        c = json.loads(run(['docker', 'inspect', ids[0]]))[0]
        need(c['State']['Running'] and c['State'].get('Health', {}).get('Status') == 'healthy', 'service not healthy: ' + role)
        labels = c['Config'].get('Labels') or {}
        need(labels.get('com.teamaibox.installation-id') == record['installationId']
             and labels.get('com.teamaibox.service-role') == role, 'service installation ownership missing')
        # Keep every admitted API namespace dependent in the installation
        # registry, so grouped upgrades cannot strand the desktop gateways.
        if role in ROLES:
            record['services'][role] = service_record(c)
    if not check:
        save(root / 'installation.json', record)
        save('/etc/teamaibox/installation.json', record)


def recipe_action(root, phase, check=False):
    """Invoke committed factory registration/recovery adapters, never shell text."""
    _, recipe = factory(root)
    release, state = read_json(root / 'release.json'), read_json(root / 'install-state.json')
    for command in recipe[phase]['check' if check else 'apply']:
        need(len(command) > 1 and command[0] == 'python3' and command[1] in release['runtimeFiles'],
             'factory action must name a bundled Python adapter')
        args = expand(command[2:], variables(root, state, release))
        run([sys.executable, within(root / 'runtime', command[1]), *args], timeout=recipe[phase]['timeoutSeconds'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--phase', choices=('storage', 'configuration', 'core', 'catalog', 'recovery', 'workers'), required=True)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--installation-root', type=Path, required=True)
    args = parser.parse_args()
    need(os.geteuid() == 0, 'root required')
    root = args.installation_root.resolve()
    if args.phase == 'storage':
        storage(root, args.check)
    elif args.phase == 'configuration':
        configuration(root, args.check)
    elif args.phase == 'core':
        services(root, args.phase, args.check)
    elif args.phase == 'workers':
        from factory_office_start import apply
        apply(root, args.check)
    else:
        recipe_action(root, args.phase, args.check)
    print(json.dumps({'phase': args.phase, 'status': 'checked' if args.check else 'applied'}))


if __name__ == '__main__':
    try:
        main()
    except (InstallError, OSError, ValueError, KeyError) as error:
        raise SystemExit('Factory phase failed: ' + str(error))

"""Assemble the maintained service adapters into the packable factory recipe."""
from pathlib import Path

from factory_foundation import foundation
from offline_common import PHASES, need, validate_factory, write_json
from package import module_closure


RUNTIME_ENTRIES = (
    'install/factory_bootstrap.py', 'install/factory_catalog.py', 'install/factory_recovery.py',
    'install/factory_casting.py', 'install/factory_office_ready.mjs', 'install/factory_owner.mjs',
    'tools/restore_existing_business_volumes.py', 'tools/restore_appliance_frontdoor.py',
    'tools/restore_calibrated_office_workers_v3.py', 'tools/appliance_network_identity.py',
    'tools/bootstrap_casting_service.py', 'deploy/android/cuttlefish/phone_usb_host_control.py',
    'deploy/android/cuttlefish/phone-seccomp.json', 'deploy/casting/trusted-media-seccomp.v1.json',
    'deploy/casting/trusted-media-callback-contract.v1.json', 'deploy/compose/nats.conf',
    'deploy/compose/agent-model-aliases.v1.json',
)


def assemble(repository):
    recipe = foundation(repository)
    recipe['schemaVersion'] = 1
    compose = next(t['value'] for t in recipe['templates'] if t['output'] == recipe['composeFile'])
    names = sorted(set(compose['services']) - {'database-migrate'})
    roles = {compose['services'][n]['labels']['com.teamaibox.service-role']: n for n in names}
    need(len(roles) == len(names), 'each factory service must have its own role')
    recipe['services'] = {'core': dict(names=names, roles=roles, timeoutSeconds=600)}
    for phase in ('catalog', 'recovery'):
        command = ['python3', 'install/factory_' + phase + '.py', '--installation-root', '@@ROOT@@']
        recipe[phase] = dict(apply=[command], check=[[*command, '--check']], timeoutSeconds=600)
    return recipe


def emit(repository, destination):
    destination = Path(destination)
    need(not destination.exists(), 'factory output must be a new directory')
    recipe = assemble(repository)
    runtime = module_closure(Path(repository).resolve(), RUNTIME_ENTRIES)
    destination.mkdir(parents=True)
    for row in recipe['templates']:
        write_json(destination / row['input'], row.pop('value'), 0o644)
    validate_factory(recipe, {r['input'] for r in recipe['templates']}, runtime)
    write_json(destination / 'factory.json', recipe, 0o644)
    return recipe, runtime


def installation_steps():
    result = []
    for phase in PHASES:
        command = ['python3', 'install/factory_bootstrap.py', '--phase', phase]
        result.append(dict(phase=phase, apply=command, check=[*command, '--check'],
                           timeoutSeconds=7200 if phase == 'workers' else 1800))
    return result


def readiness(recipe):
    rows = []
    for role in recipe['services']['core']['roles']:
        rows.append(dict(role='casting-sfu' if role == 'sfu' else role,
                         containerRole=role, timeoutSeconds=600))
    rows += [dict(role=r + '-worker', timeoutSeconds=1800)
             for r in ('assistant', 'translation', 'embedding', 'asr', 'ocr', 'drawing')]
    return rows

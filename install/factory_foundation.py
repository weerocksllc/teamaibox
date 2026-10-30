"""Build the clean foundation portion of a factory recipe.

This is a component, not a complete release recipe: office/model, desktop and
casting declarations must be assembled and validated before packaging. No
live appliance configuration, database rows or secret values are read here.
"""
from copy import deepcopy
from pathlib import Path

from factory_core import core_templates
from factory_office import definitions
from offline_common import read_json


def foundation(repository):
    repository = Path(repository)
    compose, secrets, directories = core_templates(repository)
    office = definitions(repository)
    api = compose['services']['platform-api']['environment']
    api.update(PLATFORM_PROTECTED_OFFICE_SET_ID='@@OFFICE_SET_ID@@',
               PLATFORM_PROTECTED_OFFICE_SET_NODE_ID='@@NODE_ID@@',
               PLATFORM_APPLIANCE_PROTECTED_TARGET_POLICY_DIGEST='@@OFFICE_POLICY_DIGEST@@')
    for role, profile in office['profiles'].items():
        prefix = profile['environmentPrefix']
        api.update({prefix + '_PROFILE_KEY': '@@PROFILE_KEY.' + role + '@@',
                    prefix + '_PROFILE_ID': '@@PROFILE_ID.' + role + '@@',
                    prefix + '_WORKER_ID': '@@ID.' + role + '@@'})
        for field in ('WORKER_ORIGIN', 'MODEL_ALIAS', 'SERVED_MODEL', 'PROFILE_FINGERPRINT', 'ENGINE_IMAGE_DIGEST'):
            api[prefix + '_' + field] = '@@OFFICE_ENV.' + prefix + '_' + field + '@@'
    api['OCR_WORKER_PROTOCOL'] = 'hunyuan-managed-v1'
    # The application submits intent aliases, not the worker's internal alias.
    # Without both ordinary aliases the bridge rejects queued UI requests even
    # while a direct authenticated worker health/generation probe succeeds.
    api['DRAWING_MODEL_ALIASES'] = 'local/drawing-default,drawing.automatic,drawing.fast'
    api['DRAWING_WORKER_TOKEN_FILE'] = '/run/secrets/factory_drawing_provider'
    compose['secrets']['factory_drawing_provider'] = {'file': '@@ROOT@@/secrets/drawing-provider-api'}
    compose['services']['platform-api']['secrets'].append('factory_drawing_provider')
    compose['services']['node-agent']['environment'].update(
        TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_FILE='@@ROOT@@/public/protected-office-targets.json',
        TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_DIGEST='@@OFFICE_POLICY_DIGEST@@')
    built_in = read_json(repository / 'deploy/applications/built-in-applications.v1.json')
    # Profile keys are release model metadata, not a development node's key.
    for app in built_in['applications']:
        if app['applicationKey'] == 'official.assistant':
            app['requiredModelProfiles'] = {'chat': '@@PROFILE_KEY.assistant@@'}
    templates = []
    def add(output, value, *, mode='0644', uid=0, gid=0, mutable=False, format='json'):
        templates.append(dict(input=output.replace('/', '__') + '.json', output=output, value=deepcopy(value),
                              format=format, mode=mode, uid=uid, gid=gid, runtimeMutable=mutable))
    from factory_services import auxiliary, casting
    auxiliary(compose, secrets, directories, add)
    casting(compose, add)
    from factory_plugins import plugins
    plugins(repository, compose, secrets, directories, add)
    from factory_realtime import realtime
    realtime(compose, add)
    add('config/core.json', compose, mode='0600')
    add('config/office-definition.json', office, mode='0600')
    add('config/office-runtime.json', '@@OFFICE.runtime@@', mode='0600')
    add('public/protected-office-targets.json', '@@OFFICE.policy@@', mode='0440', gid=10001)
    add('config/installation.env', {}, format='env', mode='0600')
    add('config/built-in-applications.json', built_in)
    add('public/plugin-routes.json', read_json(repository / 'deploy/appliance/plugin-routes.json'))
    for name in ('phones', 'computers'):
        add('config/guests/' + name + '.json', '@@GUEST.' + name + '@@')
    add('config/guest-catalog.json', '@@GUEST.catalogRoms@@', mode='0600')
    add('config/computer-catalog.json', '@@GUEST.catalogComputers@@', mode='0600')
    add('config/guest-storage.json', '@@GUEST.storage@@', mode='0600')
    add('config/guest-camera.json', {'nodeId': '@@NODE_ID@@', 'clientUid': 10001}, mode='0600')
    add('data/node/identity/node.json', '@@NODE.identity@@', mode='0640', uid=10001, gid=10001)
    add('data/node/identity/inventory.json', '@@NODE.inventory@@', mode='0640', uid=10001, gid=10001)
    add('public/node.json', '@@NODE.identity@@')
    add('public/appliance-addresses.json', {'addresses': [], 'dnsNames': []}, mutable=True)
    add('public/phone-media-state.json', dict(version=1, nodeId='@@NODE_ID@@', poolId='@@ID.pool@@',
                                           status='preparing', updatedAt=0, runs={}), mutable=True)
    add('public/ai-startup.json', dict(schemaVersion=1, nodeId='@@NODE_ID@@', status='pending', workers={}), mutable=True)
    add('config/frontdoor.json', dict(installationFile='@@ROOT@@/installation.json', retired=[],
        ordered=[{'role': r} for r in ('postgres', 'platform-api', 'node-agent', 'appliance-gateway', 'web')]), mode='0600')
    add('config/network-identity.json', dict(installationFile='@@ROOT@@/installation.json',
        tlsDirectory='@@ROOT@@/https', dnsNames=['teamaibox.local'],
        publicStateFile='@@ROOT@@/public/appliance-addresses.json', sfuConfig='@@CASTING.root@@/sfu/sfu.yaml',
        phoneMedia=dict(nodeId='@@NODE_ID@@', poolId='@@ID.pool@@',
                        controlRoot='@@DATA@@/guests/control/phones',
                        controlNetworkId='@@NETWORK_ID.phone-control@@',
                        stateFile='@@ROOT@@/public/phone-media-state.json')), mode='0600')
    copies = []
    for name in ('ca', 'node', 'scheduler', 'gateway', 'maintenance'):
        copies.append(dict(source=name + '.crt', path='public/' + name + '.crt', mode='0644'))
    for name in ('ca', 'node'):
        copies.append(dict(source=name + '.crt', path='data/node/identity/' + name + '.crt',
                           mode='0644', uid=10001, gid=10001))
    copies.append(dict(source='node.key', path='data/node/identity/node.key', mode='0400', uid=10001, gid=10001))
    for name in ('scheduler', 'gateway', 'maintenance'):
        copies.append(dict(source=name + '.key', path='secrets/' + name + '.key', mode='0440', uid=0, gid=10001))
    refs = dict(composeFile='config/core.json', composeEnvironment='config/installation.env',
                officeRuntime='config/office-runtime.json',
                phones='config/guests/phones.json', computers='config/guests/computers.json',
                publicAddresses='public/appliance-addresses.json', applicationRoutes='public/plugin-routes.json',
                guestStorage='config/guest-storage.json', guestCamera='config/guest-camera.json',
                frontdoor='config/frontdoor.json', networkIdentity='config/network-identity.json',
                castingInstallation='config/casting-installation.json')
    secrets.append(dict(name='drawing-provider', path='data/office/auth/drawing/provider.token',
                        format='base64url', bytes=32, mode='0400', uid=65532, gid=65532))
    return dict(templates=templates, tlsCopies=copies, secrets=secrets, directories=directories, casting=True,
                officeDefinition=next(r['input'] for r in templates if r['output'] == 'config/office-definition.json'),
                references=refs, composeFile=refs['composeFile'], composeEnvironment=refs['composeEnvironment'])

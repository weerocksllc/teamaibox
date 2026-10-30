"""Wire the existing plugin manager without a development registry dependency."""
from offline_common import read_json
from factory_services import bind


def plugins(repository, compose, secrets, directories, add):
    api = compose['services']['platform-api']
    applications = []
    for route in read_json(repository / 'deploy/appliance/plugin-routes.json')['routes']:
        role = route['pluginId'].removeprefix('official.') + '-plugin'
        manifest = read_json(repository / 'apps' / role / 'manifest.release-template.json')
        manifest['version'] = read_json(repository / 'apps' / role / 'package.json')['version']
        # The package checksum authenticates these shipped manifests. Do not
        # retain a placeholder signature or pretend to import a signed bundle.
        manifest.pop('signature', None)
        for image in manifest['images']:
            for variant in image['variants']:
                variant.update(reference='@@IMAGE.' + role + '@@', digest='@@IMAGE.' + role + '@@')
        applications.append(dict(role=role, manifest=manifest))
    add('config/application-catalog.json', dict(schemaVersion=1, applications=applications), mode='0600')
    add('public/plugin-runtime.json', dict(schemaVersion=1,
        node=dict(nodeId='@@NODE_ID@@', nodeGeneration=1, host='127.0.0.1', port=9443,
                  expectedServerName='localhost', expectedCertificateFingerprint='@@NODE.certificateFingerprint@@',
                  commandKeyId='factory-command-v1'),
        capabilities=['object-references', 'nvidia-container-runtime'],
        applicationIngress=dict(networkName='@@NETWORK_NAME.plugin-ingress@@', containerPort=8080)))
    policy = read_json(repository / 'deploy/plugins/import-policy.v1.json')
    policy['allowedSources'] = ['offline-bundle']
    add('public/plugin-import-policy.json', policy)
    sandbox = read_json(repository / 'deploy/plugins/sandbox-policy.v1.json')
    sandbox['network']['applicationIngressNetwork'] = '@@NETWORK_NAME.plugin-ingress@@'
    add('public/plugin-sandbox-policy.json', sandbox)
    # No developer trust key, marketplace, credentials or installed packages.
    add('public/plugin-source-catalog.json', dict(schemaVersion=1, trust=[], packages=[]))
    directories.append(dict(path='plugins/offline', uid=1000, gid=1000, mode='0700'))
    secrets.append(dict(name='plugin-delegation-pepper', path='secrets/plugin-delegation-pepper',
                        format='base64url', bytes=32, mode='0440', uid=0, gid=10001))
    compose['secrets']['plugin_delegation_pepper'] = {'file':'@@ROOT@@/secrets/plugin-delegation-pepper'}
    api['secrets'].append('plugin_delegation_pepper')
    api['volumes'].append(bind('@@DATA@@/plugins/offline', '/var/lib/teamaibox/plugin-offline', False))
    api['environment'].update(
        PLATFORM_PLUGIN_RUNTIME_CONFIG_FILE='/run/config/appliance/plugin-runtime.json',
        PLATFORM_PLUGIN_IMPORT_POLICY_FILE='/run/config/appliance/plugin-import-policy.json',
        PLATFORM_PLUGIN_SANDBOX_POLICY_FILE='/run/config/appliance/plugin-sandbox-policy.json',
        PLATFORM_PLUGIN_SOURCE_CATALOG_FILE='/run/config/appliance/plugin-source-catalog.json',
        PLATFORM_PLUGIN_SOURCE_MODE='offline',
        PLATFORM_PLUGIN_OFFLINE_BUNDLE_ROOT='/var/lib/teamaibox/plugin-offline',
        PLATFORM_PLUGIN_NODE_AGENT_COMMAND_KEY_FILE='/run/secrets/node_agent_command_key',
        PLATFORM_PLUGIN_NODE_AGENT_CA_FILE='/run/config/appliance/ca.crt',
        PLATFORM_PLUGIN_NODE_AGENT_CLIENT_CERT_FILE='/run/config/appliance/scheduler.crt',
        PLATFORM_PLUGIN_NODE_AGENT_CLIENT_KEY_FILE='/run/secrets/appliance_scheduler_key',
        PLATFORM_PLUGIN_DELEGATION_PEPPER_FILE='/run/secrets/plugin_delegation_pepper',
        PLATFORM_PLUGIN_RUNTIME_NAMESPACE='factory-@@INSTALLATION_ID@@')

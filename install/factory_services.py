"""Fresh auxiliary service wiring; no live deployment environment is copied."""
from copy import deepcopy


def bind(source, target, readonly=True):
    return dict(type='bind', source=source, target=target, read_only=readonly,
                bind=dict(create_host_path=False))


def service(role, *, user='10001:10001', memory='256m'):
    return dict(image='@@IMAGE.' + role + '@@', platform='linux/arm64/v8', pull_policy='never',
                init=True, restart='unless-stopped', read_only=True, user=user, group_add=['10001'],
                cap_drop=['ALL'], security_opt=['no-new-privileges:true'], pids_limit=256,
                mem_limit=memory, memswap_limit=memory, cpus=1,
                tmpfs=['/tmp:rw,nosuid,nodev,size=256m'],
                labels={'com.teamaibox.installation-id': '@@INSTALLATION_ID@@',
                        'com.teamaibox.service-role': role})


def auxiliary(compose, secrets, directories, add):
    s = compose['services']
    api = s['platform-api']
    api['environment']['PLATFORM_PROTECTED_DATA_LUKS2'] = 'true'
    api['environment']['PLATFORM_SOURCE_GATEWAY_ORIGIN'] = 'http://source-gateway:8080'
    source = s['source-gateway']
    source['entrypoint'] = ['node', '/opt/teamaibox/validation/package-source-gateway-main.mjs']
    source['user'] = '65532:65532'
    source['volumes'] = ['source_cache:/var/lib/teamaibox-source-cache']
    source_device = compose['volumes']['source_cache']['driver_opts']['device'].removeprefix('@@DATA@@/')
    for row in directories:
        if row['path'] == source_device:
            row.update(uid=65532, gid=65532)
    # Display, input and audio use the existing Platform/Agent tunnel. No raw
    # VNC/RDP/Guacamole listener is published to a host interface.
    proxy = service('desktop-proxy', user='1000:1000', memory='512m')
    proxy.update(network_mode='service:platform-api',
        entrypoint=['/opt/guacamole/entrypoint.sh'], command=['-b', '127.0.0.1'],
        environment={'HOME': '/tmp'}, depends_on={'platform-api': {'condition': 'service_started'}},
        healthcheck=dict(test=['CMD-SHELL', 'nc -z 127.0.0.1 4822'], interval='10s', timeout='3s', retries=12))
    s['desktop-proxy'] = proxy
    desktop = service('desktop-gateway', user='1001:1001', memory='1g')
    desktop.update(network_mode='service:platform-api', secrets=['desktop_json_key'],
        entrypoint=['/bin/sh', '-ec',
            'export JSON_SECRET_KEY="$$(cat /run/secrets/desktop_json_key)"; exec /opt/guacamole/bin/entrypoint.sh'],
        environment=dict(JSON_ENABLED='true', GUACD_HOSTNAME='127.0.0.1', GUACD_PORT='4822', JAVA_OPTS='-Xmx512m'),
        depends_on={'desktop-proxy': {'condition': 'service_healthy'}},
        healthcheck=dict(test=['CMD', 'curl', '-fsS', '-o', '/dev/null', 'http://127.0.0.1:18088/guacamole/'],
                         interval='10s', timeout='3s', start_period='60s', retries=12))
    s['desktop-gateway'] = desktop

    # A blank box has no static per-user routes. The existing controller
    # provisions an isolated workspace only after that new owner signs in.
    add('config/agent-routes.json', dict(schemaVersion=1, routes=[]))
    add('config/agent-controller.json', dict(image='@@IMAGE.agent-sandbox@@',
        volume='teamaibox-@@INSTALLATION_ID@@-agent-state',
        networks=['teamaibox-@@INSTALLATION_ID@@-agent-control', 'teamaibox-@@INSTALLATION_ID@@-agent-egress']))
    for network, suffix in [('agent-control', 'agent-control'), ('agent-egress-proxy', 'agent-egress')]:
        compose['networks'].setdefault(network, {'internal': True})['name'] = 'teamaibox-@@INSTALLATION_ID@@-' + suffix
    compose['volumes']['factory_agent_state'] = dict(name='teamaibox-@@INSTALLATION_ID@@-agent-state',
        driver='local', driver_opts={'type': 'none', 'o': 'bind', 'device': '@@DATA@@/agent/dynamic'})
    directories.append(dict(path='agent/dynamic', uid=0, gid=0, mode='0700'))
    secrets.append(dict(name='dynamic-controller-token', path='secrets/dynamic-controller-token',
                        format='base64url', bytes=48, mode='0440', uid=0, gid=10001))
    compose['secrets']['dynamic_controller_token'] = {'file': '@@ROOT@@/secrets/dynamic-controller-token'}
    controller = service('agent-bridge', user='0:0')
    controller.update(entrypoint=['node', '/opt/teamaibox/services/agent-bridge/server/dynamic-sandbox-main.mjs'],
        networks=['agent-control', 'data'],
        environment={k: v for k, v in api['environment'].items() if k.startswith('PLATFORM_DATABASE_')},
        secrets=['postgres_password', {'source': 'agent_model_signing_key', 'target': 'agent-model-signing-key'}],
        volumes=[bind('@@ROOT@@/config/agent-controller.json', '/run/config/agent-controller.json'),
                 bind('@@ROOT@@/secrets/dynamic-controller-token', '/agent-control/dynamic-controller-token'),
                 bind('/var/run/docker.sock', '/var/run/docker.sock', False), 'factory_agent_state:/state'],
        depends_on={'database-migrate': {'condition': 'service_completed_successfully'}},
        healthcheck=dict(test=['CMD', 'node', '-e',
            "fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
            interval='10s', timeout='3s', retries=12))
    # Root is confined to this trusted controller, never the user sandbox.
    controller['cap_drop'] = ['ALL']
    controller['cap_add'] = ['CHOWN', 'FOWNER', 'DAC_OVERRIDE']
    s['agent-bridge'] = controller
    api['environment'].update(ASSISTANT_AGENT_BRIDGES_FILE='/run/config/agent-routes.json',
        ASSISTANT_AGENT_CONTROLLER_ORIGIN='http://agent-bridge:8080',
        ASSISTANT_AGENT_CONTROLLER_TOKEN_FILE='/run/secrets/dynamic_controller_token')
    api['secrets'].append('dynamic_controller_token')
    api['volumes'].append(bind('@@ROOT@@/config/agent-routes.json', '/run/config/agent-routes.json'))
    if isinstance(api['networks'], list):
        api['networks'].append('agent-control')
    else:
        api['networks']['agent-control'] = {}

    # No packaged development update candidates or fictional post-check pass.
    add('public/maintenance-controller.json', dict(schemaVersion=1,
        baseline=dict(version='@@RELEASE_ID@@', digest='@@CONFIGURATION_DIGEST@@', postCheckPass=False), candidates=[]))
    add('config/maintenance-runtime.json', dict(schemaVersion=1, candidates=[],
        endpoint=dict(host='127.0.0.1', port=9446, serverName='localhost'),
        tls=dict(caFile='/run/config/appliance/ca.crt', clientCertificateFile='/run/config/appliance/scheduler.crt',
                 clientKeyFile='/run/secrets/appliance_scheduler_key')))
    directories.append(dict(path='maintenance', uid=10001, gid=10001, mode='0700'))
    maintenance = service('maintenance-controller')
    maintenance.update(network_mode='service:platform-api',
        environment=dict(MAINTENANCE_CONTROLLER_CONFIG_FILE='/run/config/appliance/maintenance-controller.json',
            MAINTENANCE_CONTROLLER_NODE_IDENTITY_FILE='/run/config/appliance/node.json',
            MAINTENANCE_CONTROLLER_STATE_ROOT='/var/lib/teamaibox-maintenance',
            MAINTENANCE_CONTROLLER_CA_FILE='/run/config/appliance/ca.crt',
            MAINTENANCE_CONTROLLER_TLS_CERT_FILE='/run/config/appliance/maintenance.crt',
            MAINTENANCE_CONTROLLER_TLS_KEY_FILE='/run/secrets/maintenance_tls_key',
            MAINTENANCE_CONTROLLER_TLS_SERVER_NAME='localhost', MAINTENANCE_CONTROLLER_PORT='9446'),
        volumes=[bind('@@ROOT@@/public', '/run/config/appliance'),
                 bind('@@DATA@@/maintenance', '/var/lib/teamaibox-maintenance', False)],
        secrets=['maintenance_tls_key'], depends_on={'platform-api': {'condition': 'service_started'}})
    compose['secrets']['maintenance_tls_key'] = {'file': '@@ROOT@@/secrets/maintenance.key'}
    s['maintenance-controller'] = maintenance
    api['environment']['PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE'] = '/run/config/maintenance-runtime.json'
    api['volumes'].append(bind('@@ROOT@@/config/maintenance-runtime.json', '/run/config/maintenance-runtime.json'))


def casting(compose, add):
    s = compose['services']
    api = s['platform-api']
    api['networks'] = {name: {} for name in api['networks']}
    api['networks']['plugin-ingress'] = {'ipv4_address': '@@CASTING.platformAddress@@'}
    api['volumes'].append(bind('@@CASTING.root@@/platform', '/run/teamaibox/casting'))
    # Keys in this map are only paths/origins, never credential contents.
    for name in ('PLATFORM_CASTING_ACTIVATION_MODE', 'PLATFORM_CASTING_FAILURE_POLICY',
        'PLATFORM_APPLIANCE_NODE_GROUP_ID', 'PLATFORM_CASTING_RUNTIME_IDENTITY_FILE',
        'PLATFORM_CASTING_CALLBACK_HOST', 'PLATFORM_CASTING_CALLBACK_PORT', 'PLATFORM_CASTING_CALLBACK_CONTRACT_FILE',
        'PLATFORM_CASTING_CALLBACK_CA_FILE', 'PLATFORM_CASTING_CALLBACK_CERT_FILE', 'PLATFORM_CASTING_CALLBACK_KEY_FILE',
        'PLATFORM_TRUSTED_MEDIA_RUNTIME_ORIGIN', 'PLATFORM_TRUSTED_MEDIA_RUNTIME_SERVER_NAME',
        'PLATFORM_TRUSTED_MEDIA_RUNTIME_CA_FILE', 'PLATFORM_TRUSTED_MEDIA_RUNTIME_CLIENT_CERT_FILE',
        'PLATFORM_TRUSTED_MEDIA_RUNTIME_CLIENT_KEY_FILE', 'PLATFORM_CASTING_SIGNALLING_ORIGIN',
        'PLATFORM_CASTING_SIGNALLING_SERVER_NAME', 'PLATFORM_CASTING_SIGNALLING_CA_FILE',
        'PLATFORM_CASTING_SIGNALLING_CERT_FILE', 'PLATFORM_CASTING_SIGNALLING_KEY_FILE'):
        api['environment'][name] = '@@CAST_ENV.' + name + '@@'
    add('config/casting-installation.json', '@@CASTING.declaration@@', mode='0600')
    media = service('casting-media', user='65532:65532', memory='4g')
    # The media supervisor handles signals and reaps its children itself. Tini
    # needs syscalls deliberately absent from the media-specific seccomp policy.
    media['init'] = False
    media.update(network_mode='host', entrypoint=['/usr/bin/python3'],
        command=['-m', 'services.trusted_media_runtime.appliance'],
        volumes=[bind('@@CASTING.root@@/media', '/run/teamaibox/credentials')],
        tmpfs=['/run/avahi-daemon:rw,nosuid,nodev,noexec,uid=65532,gid=65532,mode=0700,size=4m',
               '/run/teamaibox:rw,nosuid,nodev,noexec,uid=65532,gid=65532,mode=0700,size=256m',
               '/tmp:rw,nosuid,nodev,noexec,uid=65532,gid=65532,mode=0700,size=64m'],
        healthcheck=dict(test=['CMD', 'python3', '-c',
            "import json,socket;v=json.load(open('/run/teamaibox/credentials/runtime.json'));"
            "s=socket.create_connection((v['listener']['address'],v['listener']['port']),2);s.close()"],
            interval='10s', timeout='3s', start_period='20s', retries=12))
    media['security_opt'].append('seccomp=@@RUNTIME@@/deploy/casting/trusted-media-seccomp.v1.json')
    media['pids_limit'] = 1024
    media['cpus'] = 6
    s['casting-media'] = media
    sfu = service('casting-sfu', user='65532:65532', memory='512m')
    sfu['labels']['com.teamaibox.service-role'] = 'sfu'
    sfu.update(network_mode='host', entrypoint=['/livekit-server'],
        command=['--config', '/run/teamaibox/credentials/sfu.yaml'],
        volumes=[bind('@@CASTING.root@@/sfu', '/run/teamaibox/credentials')],
        healthcheck=dict(test=['CMD', 'wget', '-q', '-T', '2', '-O', '/dev/null', 'http://127.0.0.1:19450/'],
            interval='10s', timeout='3s', start_period='20s', retries=12))
    s['sfu'] = sfu

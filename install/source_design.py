#!/usr/bin/env python3
"""Deploy the source-built Design workspace without installing a host appliance."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import sys
import uuid

from factory_bootstrap import expand
from factory_core import validate_compose
from factory_identity import secret_file
from factory_penpot import PENPOT_IMAGE_ROLES
from offline_common import atomic, digest, need, read_json, run, within, write_json
from source_install import Pipeline, configure_network, source_identity
from source_design_ai import AI_IMAGES, AI_SERVICES, checked_model, configure as configure_ai, dynamic_resources, engine_binding

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
CORE_ROLES = ('platform-api', 'postgres', 'event-bus', 'web')
IMAGE_ROLES = frozenset(CORE_ROLES) | PENPOT_IMAGE_ROLES
SERVICES = IMAGE_ROLES | {'database-migrate', 'object-service'}
OWNER_LABEL = 'com.teamaibox.source-design'
API_KEYS = frozenset('''
PLATFORM_API_PERSISTENCE PLATFORM_API_PUBLIC_ORIGIN PLATFORM_API_SETUP_TOKEN_FILE
PLATFORM_API_CREDENTIAL_PEPPER_FILE PLATFORM_OWNER_RECOVERY_KEY_FILE
PLATFORM_AUDIT_SIGNING_KEY_FILE PLATFORM_PROVIDER_SECRET_MASTER_KEY_FILE
PLATFORM_PROVIDER_SECRET_CIPHERTEXT_DIR PLATFORM_AGENT_MODEL_SIGNING_KEY_FILE
PLATFORM_AGENT_MODEL_ALIAS_MAP_FILE PLATFORM_APPLICATION_ROUTES_FILE
PLATFORM_BUILT_IN_APPLICATIONS_FILE PLATFORM_OBJECT_SERVICE_ENDPOINT
PLATFORM_OBJECT_SERVICE_TOKEN_FILE PLATFORM_OBJECT_SERVICE_HEALTH_ORIGIN
PLATFORM_EVENT_BUS_HEALTH_ORIGIN PLATFORM_SELF_HEALTH_ORIGIN
TEAMAIBOX_REQUIRED_SCHEMA_VERSION
'''.split())
OBJECT_KEYS = frozenset(('TEAMAIBOX_SERVICE_NAME', 'TEAMAIBOX_REQUIRED_SCHEMA_VERSION'))


def inspect_image(image):
    need(isinstance(image, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', image), 'image content ID required')
    item, = json.loads(run(['docker', 'image', 'inspect', image]))
    need(item['Id'] == image and item['Os'] == 'linux' and item['Architecture'] == 'arm64', 'wrong local image identity')
    return item


def reused_images(manifest_path, checksum, *, ai=False):
    # Explicit operator-selected artifact identity. No archive import, pulling,
    # install steps, or unverified tag lookup is permitted on this path.
    need(re.fullmatch('[a-f0-9]{64}', checksum or '') and manifest_path.is_file()
         and not manifest_path.is_symlink(), 'reuse manifest SHA-256 mismatch')
    with manifest_path.open('rb') as stream:
        raw = stream.read(65537)
    need(len(raw) <= 65536 and hashlib.sha256(raw).hexdigest() == checksum, 'reuse manifest SHA-256 mismatch')
    manifest = json.loads(raw)
    images = manifest.get('images')
    need(manifest.get('schemaVersion') == 1 and isinstance(images, dict) and set(images) == IMAGE_ROLES | (AI_IMAGES if ai else set()),
         'image map must specify the exact Design image closure')
    for image in images.values():
        inspect_image(image)
    return images


def build_images(pipeline, cache, *, ai=False):
    from build_penpot_stack import ROLES, build as build_stack
    from source_penpot import dependency
    images = {}
    for role in CORE_ROLES:
        report = pipeline.script('design-image-' + role, 'install/build_public_services.py', ['--roles', role], images=True)
        images[role] = read_json(report / 'images.json')['images'][role]

    def native(out):
        out.mkdir()
        stack = build_stack(cache / 'downloads', cache / 'stack', list(ROLES))
        found = dict(stack['images'])
        lock = read_json(ROOT / 'deploy/penpot-runtime-dependencies.lock.json')
        need(lock['platform'] == 'linux/arm64' and set(lock['images']) == {'penpot-postgres', 'penpot-cache'},
             'design dependency declaration incomplete')
        found.update({role: dependency(ref) for role, ref in lock['images'].items()})
        need(set(found) == PENPOT_IMAGE_ROLES, 'native Design image closure incomplete')
        write_json(out / 'images.json', dict(status='selected-images-built', images=found))

    out = pipeline.step('design-native-images', native, images=True)
    images.update(read_json(out / 'images.json')['images'])
    if ai:
        from build_penpot_agent import build as build_agent
        from build_penpot_native import build as build_native
        for role in ('assistant-worker', 'agent-sandbox'):
            out = pipeline.script('design-image-' + role, 'install/build_public_services.py', ['--roles', role], images=True)
            images[role] = read_json(out / 'images.json')['images'][role]
        def patch_agent(out):
            out.mkdir()
            native = build_native(cache / 'native-opencode')
            agent = build_agent(images['agent-sandbox'], Path(native['artifact']), native['binarySha256'], cache / 'penpot-agent')
            write_json(out / 'images.json', dict(status='selected-images-built', images={'agent-sandbox':agent['imageId']}))
        out = pipeline.step('design-native-agent', patch_agent, images=True)
        images.update(read_json(out / 'images.json')['images'])
    return images


def render(repository, root, state, images, model=None):
    from factory_recipe import assemble
    recipe = assemble(repository, penpot=True)
    templates = {row['output']: row['value'] for row in recipe['templates']}
    compose = templates['config/core.json']
    ai = state.get('ai', False)
    compose['services'] = services = {role: compose['services'][role] for role in sorted(SERVICES | ({'agent-bridge'} if ai else set()))}
    api, web, objects = (services[name] for name in ('platform-api', 'web', 'object-service'))
    api['entrypoint'] = ['node', '/opt/teamaibox/apps/platform-api/server/main.mjs']
    api['environment'] = {k: v for k, v in api['environment'].items() if k in API_KEYS or
                          k.startswith(('PLATFORM_DATABASE_', 'TEAMAIBOX_EVENT_BUS_', 'PLATFORM_PENPOT_'))}
    api['environment'].pop('PLATFORM_PENPOT_MCP_KEY_FILE', None)  # No per-user Agent in this profile.
    api['secrets'] = [k for k in api['secrets'] if '/run/secrets/' + k in api['environment'].values()]
    api['volumes'] = [v for v in api['volumes'] if isinstance(v, str) or v['target'] == '/opt/teamaibox-design-plugin']
    api['networks'] = ['edge', 'control', 'data', 'penpot-control']
    # The public API image already carries the protected-object RPC module.
    # Run it in a separate service with its own storage, secrets and network.
    objects['image'] = '@@IMAGE.platform-api@@'
    objects['user'] = '1000:1000'  # Match the source image's file ownership.
    objects['environment'] = {k: v for k, v in objects['environment'].items() if k in OBJECT_KEYS or
                              k.startswith(('PLATFORM_DATABASE_', 'TEAMAIBOX_EVENT_BUS_', 'TEAMAIBOX_OBJECT_'))}
    services['penpot-mcp']['networks'] = ['penpot-control']
    extra = configure_ai(services, templates) if ai else {}
    # The factory's CA private key must not be mounted into the isolated web service.
    web['volumes'] = [dict(type='bind', source='@@ROOT@@/https/' + name, target='/run/appliance-https/' + name,
                          read_only=True, bind=dict(create_host_path=False)) for name in ('web.key', 'web.crt')]
    origin = 'https://teamaibox.local:8443' if state['port'] is None else f"https://localhost:{state['port']}"
    web['environment'].update(WEB_PUBLIC_ORIGIN=origin, WEB_AUTO_LOCAL_ADDRESS='false',
                              WEB_PLUGIN_ROUTES_FILE='/run/config/plugin-routes.json')
    api['environment'].update(PLATFORM_API_PUBLIC_ORIGIN=origin, PLATFORM_APPLICATION_ROUTES_FILE='/run/config/plugin-routes.json')
    web.pop('ports', None)
    if state['port'] is not None:
        web['ports'] = [dict(target=8443, published=str(state['port']), host_ip='127.0.0.1', protocol='tcp')]
        web['networks'] = {'edge': {}, 'access': {}}
    else:
        web['networks'] = {'edge': {'aliases': ['teamaibox.local']}}

    for role, service in services.items():
        service['depends_on'] = {k: v for k, v in service.get('depends_on', {}).items() if k in services}
        service['labels'] = {OWNER_LABEL: '@@INSTALLATION_ID@@', 'com.teamaibox.installation-id': '@@INSTALLATION_ID@@',
                             'com.teamaibox.service-role': role}
        need(not {'devices', 'network_mode', 'privileged', 'pid', 'ipc', 'container_name'} & service.keys(),
             'unsafe service in source Design profile: ' + role)
        if role != 'web':
            need('ports' not in service, 'private service cannot publish a port')
    networks = {k for s in services.values() for k in s['networks']}
    if ai:
        networks.add('agent-egress-proxy')
    named = {k: compose['networks'][k]['name'] for k in ('agent-control','agent-egress-proxy')} if ai else {}
    compose['networks'] = {k: dict(internal=k != 'access', labels={OWNER_LABEL: '@@INSTALLATION_ID@@'}) for k in sorted(networks)}
    for key, name in named.items():
        compose['networks'][key]['name'] = name
    volumes = {v.split(':', 1)[0] for s in services.values() for v in s.get('volumes', []) if isinstance(v, str)}
    compose['volumes'] = {k: {**compose['volumes'][k], 'labels': {OWNER_LABEL: '@@INSTALLATION_ID@@'}} for k in sorted(volumes)}
    used_secrets = {k if isinstance(k, str) else k['source'] for s in services.values() for k in s.get('secrets', [])}
    compose['secrets'] = {k: compose['secrets'][k] for k in sorted(used_secrets)}
    used_configs = {v['source'] for s in services.values() for v in s.get('configs', [])}
    compose['configs'] = {k: compose['configs'][k] for k in sorted(used_configs)}
    values = dict(ROOT=str(root), DATA=str(root / 'data'), RUNTIME=str(root / 'runtime'),
                  INSTALLATION_ID=state['installationId'], RELEASE_ID='design-' + state['sourceIdentity'][:12],
                  **{'ASSET.penpot-plugin': str(root / 'assets/plugin')})
    values.update({'IMAGE.' + k: v for k, v in images.items()})
    if ai:
        need(model and state.get('engineSocket'), 'Design AI requires verified local model and dedicated engine')
        values.update(DESIGN_MODEL=str(model), DESIGN_ENGINE_SOCKET=state['engineSocket'])
    compose = expand(compose, values)
    files = expand(extra, values)
    if state.get('slotId'):
        for role, spec in compose['volumes'].items():
            if 'name' in spec:
                spec['name'] = 'teamaibox-'+state['slotId']+'-'+role
        if ai:
            controller = files['config/agent-controller.json']
            controller['volume'] = compose['volumes']['factory_agent_state']['name']
            for role in ('agent-control', 'agent-egress-proxy'):
                compose['networks'][role]['name'] = 'teamaibox-'+state['slotId']+'-'+role
            controller['networks'] = [compose['networks'][role]['name'] for role in ('agent-control', 'agent-egress-proxy')]
    validate_compose(compose, images.values())
    for role, service in compose['services'].items():
        for mount in service.get('volumes', []):
            if isinstance(mount, dict):
                source = Path(mount['source'])
                dedicated_socket = ai and role == 'agent-bridge' and str(source) == state['engineSocket'] and mount['target'] == '/var/run/docker.sock'
                need(mount['type'] == 'bind' and (source.is_relative_to(root) or dedicated_socket), 'bind escapes Design instance')
    devices = [Path(v['driver_opts']['device']) for v in compose['volumes'].values()]
    need(all(p.is_relative_to(root / 'data') and '..' not in p.parts for p in devices), 'volume escapes Design instance')
    directories = {p.relative_to(root / 'data').as_posix() for p in devices}
    dirs = [{**v, 'uid': 1000, 'gid': 1000} if v['path'] in ('objects', 'objects/staging') else v
            for v in recipe['directories'] if v['path'] in directories]
    need({v['path'] for v in dirs} == directories, 'Design persistence declaration incomplete')
    secrets = [v for v in recipe['secrets'] if str(root / v['path']) in {s['file'] for s in compose['secrets'].values()}]
    need(len(secrets) == len(used_secrets), 'Design secret declaration incomplete')
    catalog = templates['config/application-catalog.json']
    rows = [row for row in catalog['applications'] if row['manifest']['id'] == 'official.penpot']
    files = {**files, 'compose.json': compose, 'public/plugin-routes.json': templates['public/plugin-routes.json'],
             'config/built-in-applications.json': {'schemaVersion': 1, 'applications': []},
             'config/application-catalog.json': dict(applications=expand(rows, values), requiredApplications=['official.penpot'])}
    return origin, files, dirs, secrets


def owned_resources(compose, state):
    project, identity = state['project'], state['installationId']
    containers = run(['docker', 'ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project]).split()
    rows = json.loads(run(['docker', 'container', 'inspect', *containers])) if containers else []
    names = set()
    for row in rows:
        labels = row['Config']['Labels'] or {}
        role = labels.get('com.docker.compose.service')
        need(labels.get(OWNER_LABEL) == identity and role in compose['services'] and role not in names
             and row['Image'] == compose['services'][role]['image'], 'foreign or changed Design container; no action taken')
        names.add(role)
    agents = dynamic_resources(Path(state['root']), compose) if state.get('ai') else []
    if state.get('engineRoot'):
        engine_ids = set(run(['docker', 'ps', '-aq', '--no-trunc']).split())
        need(engine_ids == {r['Id'] for r in rows + agents}, 'dedicated engine contains unrelated containers')
    for kind in ('network', 'volume'):
        names = run(['docker', kind, 'ls', '--format', '{{.Name}}']).split()
        for key, spec in compose[kind + 's'].items():
            name = spec.get('name', project + '_' + key)
            if name not in names:
                continue
            item, = json.loads(run(['docker', kind, 'inspect', name]))
            need((item['Labels'] or {}).get(OWNER_LABEL) == identity, 'foreign Design ' + kind + '; no action taken')
            if kind == 'network':
                need(item['Internal'] == spec['internal'] and all(i in {r['Id'] for r in rows + agents} for i in (item['Containers'] or {})),
                     'Design network has unexpected access or attached containers')
            else:
                need(item['Driver'] == 'local' and item['Options'] == spec['driver_opts'], 'Design volume binding changed')
    return rows


def configuration(root, state, images, workspace, model=None):
    from appliance_https import initialize
    from source_penpot import plugin_asset
    origin, files, dirs, secrets = render(ROOT, root, state, images, model)
    for row in dirs:
        directory = within(root / 'data', row['path'])
        directory.mkdir(parents=True, exist_ok=True)
        os.chown(directory, row['uid'], row['gid'])
        os.chmod(directory, int(row['mode'], 8))
    for row in secrets:
        secret_file(row, root)
    initialize(root / 'https', 1000)
    plugin = workspace.step('design-plugin', lambda out: plugin_asset(images['penpot-mcp'], out))
    # Mount the verified artifact directly from a persistent, instance-owned
    # location. Staging via rename prevents a partial copy on resume.
    target = root / 'assets/plugin'
    if not target.exists():
        import tempfile
        target.parent.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=target.parent) as tmp:
            stage = Path(tmp) / 'plugin'
            shutil.copytree(plugin, stage)
            stage.rename(target)
    from source_install import tree_inventory
    need(tree_inventory(target) == tree_inventory(plugin), 'deployed Design plugin differs from source artifact')
    for rel in ('deploy/compose/nats.conf', 'deploy/compose/agent-model-aliases.v1.json'):
        dest = within(root, 'runtime/' + rel)
        raw = (ROOT / rel).read_bytes()
        if dest.exists():
            need(dest.read_bytes() == raw, 'Design runtime configuration changed')
        else:
            atomic(dest, raw, 0o644)
    for rel, value in files.items():
        dest = within(root, rel)
        if dest.exists():
            need(read_json(dest) == value, 'Design configuration changed; existing instance preserved: ' + rel)
        else:
            write_json(dest, value, 0o600 if rel == 'compose.json' else 0o644)
    return origin, files['compose.json']


def compose_command(root, state):
    return ['docker', 'compose', '--project-name', state['project'], '--project-directory', str(root),
            '-f', str(root / 'compose.json')]


def start_configured(root, state, compose):
    prefix = compose_command(root, state)
    origin = compose['services']['web']['environment']['WEB_PUBLIC_ORIGIN']
    owned_resources(compose, state)
    write_json(root / 'readiness.json', dict(status='starting', origin=origin))
    try:
        timeout = 1200 if state.get('ai') else 300
        run([*prefix, 'up', '-d', '--no-build', '--pull', 'never', '--no-recreate', '--wait', '--wait-timeout', str(timeout)], timeout=timeout+50)
        rows = owned_resources(compose, state)
        from appliance_installation import save, service_record
        record = dict(version=1, installationId=state['installationId'], nodeId=state['nodeId'],
                      services={c['Config']['Labels']['com.docker.compose.service']: service_record(c) for c in rows
                                if c['Config']['Labels']['com.docker.compose.service'] in ('postgres', 'platform-api', 'web')})
        save(root / 'installation.json', record)
        write_json(root / 'install-state.json', dict(installationId=state['installationId'], nodeId=state['nodeId']))
        from factory_applications import apply
        report = apply(root, profile='design')
    except Exception:
        write_json(root / 'readiness.json', dict(status='failed', stage='startup-or-catalog', origin=origin))
        raise
    write_json(root / 'readiness.json', dict(status='ready', origin=origin, application=report, aiAssistant=state.get('ai', False)))
    return origin


def verify_agent_image(image):
    agent = inspect_image(image)['Config']
    labels = agent.get('Labels') or {}
    entrypoint = '/opt/teamaibox/validation/opencode-agent-sandbox-main.mjs'
    need(labels.get('com.teamaibox.opencode.modified-by-platform') == 'true'
         and agent.get('Entrypoint') == ['node', entrypoint],
         'Design requires the pinned patched OpenCode runtime image')
    run(['docker','run','--rm','--network','none','--read-only','--cap-drop','ALL',
         '--security-opt','no-new-privileges','--user','65532:65532','--entrypoint','node',image,'--check',entrypoint])


def main():
    from source_design_lifecycle import activation_allowed, check_identity, transition
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('up', 'stop', 'upgrade', 'rollback'))
    parser.add_argument('--root', required=True, type=Path, help='new private instance directory, outside the source checkout')
    parser.add_argument('--target-root', type=Path, help='separate candidate directory for upgrade or rollback')
    parser.add_argument('--port', type=int, default=18443, help='loopback HTTPS port (default 18443)')
    parser.add_argument('--internal-only', action='store_true', help='no published ports; use isolated Docker clients')
    parser.add_argument('--reuse-images', type=Path, help='verified image map for already-loaded, exact ARM64 image IDs')
    parser.add_argument('--images-sha256', help='required SHA-256 of the selected image map')
    parser.add_argument('--prepare-only', action='store_true', help='prepare images without starting services')
    parser.add_argument('--registry-mirror', help='optional HTTPS mirror for digest-pinned Docker Hub build inputs')
    parser.add_argument('--with-ai', action='store_true', help='provision native per-user OpenCode and the local assistant model')
    parser.add_argument('--engine-root', type=Path, help='dedicated Docker daemon root, with docker.sock and docker-data')
    parser.add_argument('--assistant-model-release', type=Path, help='verified release.json with the assistant model assets')
    parser.add_argument('--model-release-sha256', help='trusted SHA-256 of the model release manifest')
    args = parser.parse_args()
    need(os.geteuid() == 0 and platform.system() == 'Linux' and platform.machine() in ('aarch64', 'arm64'),
         'use sudo on a Linux ARM64 Docker host')
    need(1024 <= args.port <= 65535, 'choose an unprivileged HTTPS port')
    need(bool(args.reuse_images) == bool(args.images_sha256), 'reuse manifest and checksum must be provided together')
    need(not (args.reuse_images and args.registry_mirror), 'a registry mirror cannot be used with local image reuse')
    need(args.action == 'up' or not args.prepare_only, 'prepare-only is an up option')
    switching = args.action in ('upgrade', 'rollback')
    need(bool(args.target_root) == switching, 'upgrade and rollback require a separate --target-root')
    need(not switching or (args.engine_root and not (args.with_ai or args.internal_only or args.port != 18443
         or args.registry_mirror)), 'switches inherit the baseline profile and require its dedicated engine')
    need(not switching or bool(args.reuse_images) == (args.action == 'upgrade'), 'only upgrade requires an explicit trusted image map')
    need(not args.with_ai or args.engine_root is not None, 'AI requires an explicitly dedicated Docker engine')
    need(bool(args.assistant_model_release) == bool(args.model_release_sha256), 'model manifest and checksum must be provided together')
    need(not args.assistant_model_release or (args.action == 'up' and args.with_ai) or args.action == 'upgrade',
         'model release is used only by AI startup or upgrade')
    need(not (args.action == 'up' and args.with_ai and not args.prepare_only) or args.assistant_model_release,
         'AI requires verified assistant weights before startup')
    for key in ('DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'DOCKER_CONFIG', 'COMPOSE_PROJECT_NAME',
                'COMPOSE_FILE', 'COMPOSE_ENV_FILES', 'COMPOSE_PROFILES'):
        os.environ.pop(key, None)
    os.environ.update(DOCKER_HOST='unix:///var/run/docker.sock', COMPOSE_DISABLE_ENV_FILE='1',
                      GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_COUNT='1',
                      GIT_CONFIG_KEY_0='safe.directory', GIT_CONFIG_VALUE_0=str(ROOT))
    root = args.root.absolute()
    need(root == root.resolve() and root != Path('/') and not root.is_relative_to(ROOT) and not ROOT.is_relative_to(root),
         'instance root must be a distinct non-symlink path outside source')
    engine = engine_binding(args.engine_root)
    if engine:
        engroot = Path(engine['root'])
        need(not root.is_relative_to(engroot) and not engroot.is_relative_to(root), 'instance and engine roots must be separate')
        need(not args.with_ai or args.prepare_only or engine['nvidia'], 'dedicated engine needs its NVIDIA runtime')
        os.environ['DOCKER_HOST'] = 'unix://' + engine['socket']
    if not root.exists():
        need(args.action == 'up', 'unknown Design instance')
        root.mkdir(mode=0o700)
    need(root.is_dir() and root.stat().st_uid == 0 and root.stat().st_mode & 0o077 == 0,
         'instance root must be private and root-owned')
    state_file = within(root, 'design-state.json')
    if not state_file.exists():
        need(args.action == 'up' and set(root.iterdir()) <= {root / 'design.lock'},
             'existing directory is not an owned Design instance; preserved')
    with within(root, 'design.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if not state_file.exists():
            need(args.action == 'up' and set(root.iterdir()) == {root / 'design.lock'},
                 'existing directory is not an owned Design instance; preserved')
            if engine:
                need(not run(['docker','ps','-aq']).strip(), 'dedicated engine already has containers')
            ident = uuid.uuid4()
            write_json(state_file, dict(schemaVersion=1, installationId=str(ident), nodeId=str(uuid.uuid4()),
                       project='teamaibox-design-' + ident.hex, root=str(root), sourceIdentity=source_identity(ROOT),
                       port=None if args.internal_only else args.port, reuseChecksum=args.images_sha256, ai=args.with_ai,
                       engineRoot=engine['root'] if engine else None, engineId=engine['id'] if engine else None,
                       engineSocket=engine['socket'] if engine else None, modelChecksum=args.model_release_sha256))
        state = read_json(state_file)
        check_identity(root, state)
        need((state.get('engineRoot'), state.get('engineId')) == ((engine['root'], engine['id']) if engine else (None,None)),
             'Design instance engine identity differs; no services touched')
        prefix = compose_command(root, state)
        if switching:
            need(not state.get('ai') or engine['nvidia'], 'dedicated engine needs its NVIDIA runtime')
            transition(sys.modules[__name__], args, root, state)
            return
        if args.action == 'stop':
            config = within(root, 'compose.json')
            need(config.is_file() and digest(config) == state.get('composeSha256'), 'unknown or changed Design configuration')
            compose = read_json(config)
            owned_resources(compose, state)
            if state.get('ai'):
                run([*prefix, 'stop', 'agent-bridge'], timeout=90)
                agents = [r['Id'] for r in dynamic_resources(root, compose) if r['State']['Running']]
                if agents:
                    run(['docker','container','stop',*agents], timeout=150)
            run([*prefix, 'stop'], timeout=150)
            write_json(root / 'readiness.json', dict(status='stopped', dataRetained=True))
            print('Design services stopped; instance data retained.')
            return
        activation_allowed(root, state)
        need(state['sourceIdentity'] == source_identity(ROOT) and state['port'] == (None if args.internal_only else args.port)
             and state['reuseChecksum'] == args.images_sha256 and state.get('ai',False) == args.with_ai
             and state.get('modelChecksum') == args.model_release_sha256,
             'source or options differ; use a new root, existing data preserved')
        run(['docker', 'compose', 'version'])
        pipeline = Pipeline(within(root, 'build'), state['sourceIdentity'], root)
        try:
            if args.reuse_images:
                images = reused_images(args.reuse_images, args.images_sha256, ai=args.with_ai)
            else:
                configure_network(pipeline.work, 'global', None, args.registry_mirror)
                images = build_images(pipeline, within(root, 'cache'), ai=args.with_ai)
                for image in images.values():
                    inspect_image(image)
            write_json(root / 'image-map.json', dict(schemaVersion=1, images=images,
                       installerSourceIdentity=state['sourceIdentity'], reused=bool(args.reuse_images)))
            if args.prepare_only:
                print(f'Design images ready: {root / "image-map.json"}. Services were not started.')
                return
            if args.with_ai:
                verify_agent_image(images['agent-sandbox'])
            model = checked_model(args.assistant_model_release,args.model_release_sha256,root) if args.with_ai else None
            _, compose = configuration(root, state, images, pipeline, model)
            state['composeSha256'] = digest(root / 'compose.json')
            write_json(state_file, state)
            origin = start_configured(root, state, compose)
            print(f'Design workspace ready: {origin}\nUse the owner setup token from {root / "secrets/owner-setup-token"}.')
        finally:
            pipeline.lock.close()


if __name__ == '__main__':
    try:
        main()
    except (Exception, KeyboardInterrupt) as error:
        hint = ('Keep both instance directories. If a generation switch started, use design rollback with the same roots and engine.'
                if sys.argv[1:2] == ['upgrade'] else 'Keep the instance and rerun the same command after fixing the reported stage.')
        raise SystemExit('Design deployment stopped: ' + str(error) + '\n' + hint)

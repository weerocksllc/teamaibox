"""Explicit native design stack, with target-generated identities and storage.

Only selected by a release declaring the complete Penpot image/asset closure.
No live environment, account, design or development configuration is imported.
"""
from factory_services import service, bind
from factory_application_contract import bind_application_images, validate_application_set
from offline_common import need, read_json

PENPOT_IMAGE_ROLES = frozenset('penpot-' + name for name in ('frontend', 'backend', 'exporter', 'mcp', 'postgres', 'cache'))
PENPOT_ASSET_ROLES = frozenset({'penpot-plugin', 'penpot-corresponding-source'})


def selected_features(features):
    need(isinstance(features, list) and all(isinstance(v, str) for v in features) and len(features) == len(set(features))
         and set(features) <= {'penpot'}, 'unknown or duplicate release feature')
    return 'penpot' in features


def configure(repository, compose, secrets, directories, templates):
    services, api = compose['services'], compose['services']['platform-api']
    need(not any(role in services for role in PENPOT_IMAGE_ROLES), 'design services already declared')
    compose['networks']['penpot-data'] = {'internal': True}
    compose['networks']['penpot-control'] = {'internal': True}
    api['networks']['penpot-control'] = {}
    for name, uid in [('database', 999), ('cache', 999), ('assets', 1001), ('exports', 1001)]:
        compose['volumes']['penpot_' + name] = dict(name='teamaibox-@@INSTALLATION_ID@@-penpot-' + name,
            driver='local', driver_opts={'type':'none', 'o':'bind', 'device':'@@DATA@@/penpot/' + name})
        directories.append(dict(path='penpot/' + name, uid=uid, gid=uid, mode='0700'))
    for name in ('database', 'backend', 'session', 'mcp', 'pepper'):
        secret = 'penpot_' + name
        secrets.append(dict(name='penpot-' + name, path='secrets/penpot-' + name,
            format='base64url', bytes=32, uid=0, gid=10001, mode='0440'))
        compose['secrets'][secret] = {'file':'@@ROOT@@/secrets/penpot-' + name}
    api['secrets'] += ['penpot_backend', 'penpot_mcp', 'penpot_pepper']
    api['environment'].update(PLATFORM_PENPOT_INSTALLATION_ID='@@INSTALLATION_ID@@',
        PLATFORM_PENPOT_TOKEN_PEPPER_FILE='/run/secrets/penpot_pepper',
        PLATFORM_PENPOT_BACKEND_KEY_FILE='/run/secrets/penpot_backend',
        PLATFORM_PENPOT_MCP_KEY_FILE='/run/secrets/penpot_mcp',
        PLATFORM_PENPOT_FRONTEND_ORIGIN='http://penpot-frontend:8080',
        PLATFORM_PENPOT_BACKEND_ORIGIN='http://penpot-backend:6060',
        PLATFORM_PENPOT_EXPORTER_ORIGIN='http://penpot-exporter:6061',
        PLATFORM_PENPOT_MCP_WEBSOCKET_ORIGIN='http://penpot-mcp:4402',
        PLATFORM_PENPOT_MCP_PLUGIN_DIRECTORY='/opt/teamaibox-design-plugin')
    api['volumes'].append(bind('@@ASSET.penpot-plugin@@', '/opt/teamaibox-design-plugin'))
    controller = next(t['value'] for t in templates if t['output'] == 'config/agent-controller.json')
    controller['penpot'] = dict(enabled=True, transportRevision='teamaibox-penpot-transport-2',
        platformOrigin='http://platform-api:8080', mcpOrigin='http://penpot-mcp:4401')

    def native(name, uid, memory, networks):
        value = service('penpot-' + name, user=f'{uid}:{uid}', memory=memory)
        value['networks'] = networks
        services['penpot-' + name] = value
        return value
    def health(command, start='30s'):
        return dict(test=command, interval='10s', timeout='5s', retries=12, start_period=start)
    def http_health(port, path):
        return health(['CMD','node','-e',f"fetch('http://127.0.0.1:{port}{path}',{{signal:AbortSignal.timeout(3000)}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"])
    pg = native('postgres', 999, '512m', ['penpot-data'])
    pg.update(environment=dict(POSTGRES_USER='penpot', POSTGRES_DB='penpot',
        POSTGRES_PASSWORD_FILE='/run/secrets/penpot_database', PGDATA='/var/lib/postgresql/data/pgdata'),
        volumes=['penpot_database:/var/lib/postgresql/data'], secrets=['penpot_database'],
        tmpfs=['/tmp:rw,nosuid,nodev,size=64m', '/var/run/postgresql:rw,nosuid,nodev,uid=999,gid=999,size=8m'],
        healthcheck=health(['CMD','pg_isready','-h','127.0.0.1','-U','penpot','-d','penpot']))
    cache = native('cache', 999, '256m', ['penpot-data'])
    cache.update(command=['valkey-server','--appendonly','yes','--save','', '--dir','/data'],
        volumes=['penpot_cache:/data'], healthcheck=health(['CMD','valkey-cli','ping']))
    backend = native('backend', 1001, '2g', ['penpot-data','penpot-control'])
    backend.update(cpus=2, volumes=['penpot_assets:/opt/data/assets'],
        # zstd-jni extracts a native library here on the first file save.
        # Docker tmpfs defaults to noexec unless exec is explicit.
        tmpfs=['/tmp:rw,exec,nosuid,nodev,size=256m'],
        secrets=['penpot_database','penpot_session','penpot_backend'],
        entrypoint=['bash','-ec', 'export PENPOT_DATABASE_PASSWORD="$$(cat /run/secrets/penpot_database)"; '
            'export PENPOT_SECRET_KEY="$$(cat /run/secrets/penpot_session)"; '
            'export PENPOT_TEAMAIBOX_HANDOFF_KEY="$$(cat /run/secrets/penpot_backend)"; exec bash run.template.sh'],
        environment=dict(PENPOT_DATABASE_URI='postgresql://penpot-postgres:5432/penpot',
            PENPOT_DATABASE_USERNAME='penpot', PENPOT_REDIS_URI='redis://penpot-cache:6379/0',
            PENPOT_PUBLIC_URI='http://penpot-frontend:8080', PENPOT_ASSETS_STORAGE_BACKEND='assets-fs',
            PENPOT_STORAGE_ASSETS_FS_DIRECTORY='/opt/data/assets',
            PENPOT_TEAMAIBOX_HANDOFF_URI='http://platform-api:8080/internal/v1/design/login-handoff',
            PENPOT_TEAMAIBOX_TEAM_ROLES_URI='http://platform-api:8080/internal/v1/design/team-roles',
            PENPOT_TEAMAIBOX_DRIVE_IMPORT_CHECK_URI='http://platform-api:8080/internal/v1/design/drive-import-check',
            PENPOT_FLAGS='disable-registration disable-login-with-password disable-email-verification disable-telemetry',
            JAVA_TOOL_OPTIONS='-Xmx1400m -XX:ActiveProcessorCount=2'),
        depends_on={'penpot-postgres':{'condition':'service_healthy'},'penpot-cache':{'condition':'service_healthy'}},
        healthcheck=http_health(6060,'/readyz'))
    exporter = native('exporter',1001,'1g',['penpot-control','penpot-data'])
    exporter.update(environment=dict(PENPOT_PUBLIC_URI='http://penpot-frontend:8080',PENPOT_REDIS_URI='redis://penpot-cache:6379/0',
        PENPOT_TEAMAIBOX_PROTECTED_EXPORT='true'),
        secrets=['penpot_session'],
        entrypoint=['sh','-ec','export PENPOT_SECRET_KEY="$$(cat /run/secrets/penpot_session)"; exec node app.js'],
        volumes=['penpot_exports:/tmp'], networks=['penpot-control','penpot-data'], tmpfs=[],
        shm_size='256m', healthcheck=http_health(6061,'/readyz'))
    front = native('frontend',1001,'512m',['penpot-control'])
    # Native entrypoint renders nginx/config.js inside this disposable layer.
    # Design assets stay on the backend-owned volume mounted read-only here.
    front.update(read_only=False, tmpfs=[], volumes=['penpot_assets:/opt/data/assets:ro'],
        environment=dict(PENPOT_BACKEND_URI='http://penpot-backend:6060', PENPOT_EXPORTER_URI='http://penpot-exporter:6061',
            NGINX_WORKER_PROCESSES='2'),
        healthcheck=health(['CMD','curl','-fsS','-o','/dev/null','http://127.0.0.1:8080/index.html']))
    mcp = native('mcp',1000,'512m',['penpot-control','agent-control'])
    mcp.update(secrets=['penpot_mcp'],
        entrypoint=['sh','-ec','export TEAMAIBOX_DESIGN_AUTHORITY_KEY="$$(cat /run/secrets/penpot_mcp)"; exec node dist/index.js --multi-user'],
        environment=dict(PENPOT_MCP_SERVER_HOST='0.0.0.0',
            TEAMAIBOX_DESIGN_AUTHORITY_URL='http://platform-api:8080/internal/v1/design/call-authority'),
        healthcheck=health(['CMD','node','-e',"const n=require('net');const s=n.connect(4401,'127.0.0.1',()=>{s.end();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),3000)"]))
    # Manual design startup has no depends_on for AI; platform startup has no
    # dependency on the optional native stack at all.
    catalog = next(t['value'] for t in templates if t['output'] == 'config/application-catalog.json')
    manifest = read_json(repository / 'deploy/applications/penpot.release-template.json')
    api['environment']['PLATFORM_PENPOT_VERSION'] = manifest['version']
    mapping = {role:role for role in sorted(PENPOT_IMAGE_ROLES)}
    catalog['applications'].append(dict(role='penpot-frontend', manifest=manifest,
        services=bind_application_images(manifest,mapping)))
    catalog['requiredApplications'].append('official.penpot')
    validate_application_set(catalog['applications'],catalog['requiredApplications'])

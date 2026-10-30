"""Fresh-install office worker declarations, independent of development hosts.

The model/engine settings below match the maintained product profiles. Mutable
IDs, secrets, volume names and cache contents are generated per installation.
This module does not claim model readiness or copy a live container's state.
"""
from copy import deepcopy
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import uuid

from offline_common import need, read_json, run, within, write_json

GIB = 1024 ** 3
PROFILES = {
    'assistant': ('qwen38-main-protected-profile.v1.json', 'LOCAL_OPENAI', 'chat', 'office.assistant-qwen38', 34259636224),
    'translation': ('lmt4-protected-profile.v1.json', 'TRANSLATION', 'translation', 'office.translation-lmt4', 11076583424),
    'embedding': ('qwen3-embedding-main-protected.v1.json', 'EMBEDDING', 'embedding', 'office.embedding-qwen3', 6380531712),
    'asr': ('asr-whisper-main-protected-profile.v1.json', 'ASR', 'asr', 'office.asr-whisper', 1428910080),
    'ocr': ('hunyuan-ocr-main-protected-profile.v1.json', 'OCR', 'ocr', 'office.ocr-hunyuan', 6496006144),
    'drawing': ('flux2-klein-bf16-main-protected-profile.v1.json', 'DRAWING', 'image-generation', 'office.drawing-flux2', 9077809152),
}


def metadata(repository):
    """Select model metadata, never import profile target/source host settings."""
    result = {}
    for role, (filename, prefix, capability, target, resident) in PROFILES.items():
        p = read_json(Path(repository) / 'deploy/compute' / filename)
        result[role] = dict(profileKey=p['profileKey'], capability=capability,
                            model=p['source']['model'], revision=p['source']['revision'],
                            servedModel=p['runtime'].get('servedModel', 'lmt-60-4b-nvfp4-mlp-edge'),
                            license=deepcopy(p['source']['license']),
                            engine={k: p['engine'][k] for k in ('name', 'version')},
                            precision=deepcopy(p.get('precision', {'weights': p['engine'].get('precision')})),
                            targetKey=target, environmentPrefix=prefix,
                            declaredResidentBytes=resident, hardMemoryBytes=p['runtime']['hardMemoryBytes'])
    return result


def health(port, *, path='/health', seconds=240, python='python3', authenticated=False, prepare=False):
    source = "import urllib.request;urllib.request.urlopen('http://127.0.0.1:%d%s',timeout=3).read()" % (port, path)
    if authenticated:
        source = ("import pathlib,urllib.request;t=pathlib.Path('/run/secrets/auth/provider.token').read_text().strip();"
                  "q=urllib.request.Request('http://127.0.0.1:%d%s',headers={'Authorization':'Bearer '+t});"
                  "urllib.request.urlopen(q,timeout=3).read()") % (port, path)
    if prepare:
        source = ("import json,urllib.request;r=urllib.request.Request('http://127.0.0.1:8000/v1/models/prepare',"
                  "data=json.dumps({'model':'hunyuanocr-1.5-bf16-dflash'}).encode(),headers={'Content-Type':'application/json'});"
                  "v=json.load(urllib.request.urlopen(r,timeout=170));assert v.get('loaded') is True")
    return dict(test=['CMD', python, '-c', source], intervalNanoseconds=(180 if prepare else 10) * 10**9,
                timeoutNanoseconds=(180 if prepare else 5) * 10**9, startPeriodNanoseconds=seconds * 10**9, retries=30)


def definitions(repository):
    profiles = metadata(repository)
    common = dict(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1', HF_HUB_DISABLE_TELEMETRY='1',
                  HOME='/tmp', USER='teamaibox', LOGNAME='teamaibox',
                  TORCHINDUCTOR_CACHE_DIR='/tmp/torchinductor', VLLM_CACHE_ROOT='/tmp/vllm')
    specs = {}
    for role, p in profiles.items():
        uid = 10001 if role == 'asr' else 65532
        specs[role] = dict(entrypoint=['vllm'], command=[], environment=deepcopy(common),
                           user=uid, port=8000, memoryBytes=p['hardMemoryBytes'], cpuQuotaMicros=1200000,
                           pidsLimit=1024, sharedMemoryBytes=2 * GIB, ephemeralBytes=2 * GIB,
                           openFilesLimit=65536, tmpfsExecutable=True, gpu=role != 'asr',
                           modelTarget='/model', cacheTargets=['/tmp/.cache', '/tmp/.nv/ComputeCache',
                                                              '/tmp/.triton/cache', '/tmp/torchinductor', '/tmp/vllm'])
    specs['assistant'].update(command=['serve', '/model', '--served-model-name', profiles['assistant']['servedModel'],
        '--host', '0.0.0.0', '--port', '8000', '--dtype', 'auto', '--quantization', 'modelopt',
        '--language-model-only', '--mm-processor-cache-gb', '0', '--tensor-parallel-size', '1',
        '--gpu-memory-utilization', '0.40', '--kv-cache-dtype', 'fp8', '--kv-cache-memory-bytes', '3221225472',
        '--attention-backend', 'flashinfer', '--max-model-len', '32768', '--max-num-seqs', '2',
        '--max-num-batched-tokens', '8192', '--enable-chunked-prefill', '--enable-prefix-caching',
        '--async-scheduling', '--reasoning-parser', 'qwen3', '--tool-call-parser', 'qwen3_xml',
        '--enable-auto-tool-choice', '--seed', '1337'], cpuQuotaMicros=1600000, pidsLimit=2048,
        sharedMemoryBytes=8 * GIB, ephemeralBytes=8 * GIB, healthCheck=health(8000, seconds=900))
    specs['assistant']['environment']['TOKENIZERS_PARALLELISM'] = 'false'
    specs['translation'].update(command=['serve', '/model', '--served-model-name', profiles['translation']['servedModel'],
        '--host', '0.0.0.0', '--port', '8008', '--max-model-len', '4096', '--generation-config', 'vllm',
        '--quantization', 'modelopt', '--language-model-only', '--mm-processor-cache-gb', '0',
        '--tensor-parallel-size', '1', '--gpu-memory-utilization', '0.20', '--kv-cache-memory-bytes', '2G',
        '--kv-cache-dtype', 'fp8', '--max-num-seqs', '4', '--max-num-batched-tokens', '2048',
        '--enable-prefix-caching', '--async-scheduling', '--seed', '1337'], port=8008,
        ephemeralBytes=GIB // 2, healthCheck=health(8008))
    specs['embedding'].update(command=['serve', '/model', '--host', '0.0.0.0', '--port', '8010',
        '--served-model-name', profiles['embedding']['servedModel'], '--runner', 'pooling', '--convert', 'embed',
        '--trust-remote-code', '--gpu-memory-utilization', '0.04', '--kv-cache-memory-bytes', '1073741824',
        '--max-model-len', '8192', '--max-num-seqs', '8'], port=8010, cpuQuotaMicros=800000,
        sharedMemoryBytes=GIB, healthCheck=health(8010, seconds=360))
    specs['asr'].update(entrypoint=['python', '/opt/teamaibox/server.py'], port=8080,
        modelTarget='/models/faster-whisper-small', cpuQuotaMicros=800000, pidsLimit=256,
        sharedMemoryBytes=64 * 1024**2, ephemeralBytes=256 * 1024**2, openFilesLimit=4096,
        tmpfsExecutable=False, cacheTargets=[], healthCheck=health(8080, path='/health/ready', seconds=30, python='python'))
    specs['asr']['environment'].update(ASR_CPU_THREADS='8', ASR_HOST='0.0.0.0', ASR_PORT='8080',
        ASR_MODEL_ALIAS=profiles['asr']['servedModel'], ASR_MODEL_DIRECTORY='/models/faster-whisper-small',
        ASR_MODEL_REPOSITORY=profiles['asr']['model'], ASR_MODEL_REVISION=profiles['asr']['revision'],
        ASR_MAX_UPLOAD_BYTES='')
    specs['ocr'].update(entrypoint=['python3', '/opt/teamaibox/ocr-worker/managed_dflash_server.py'],
        modelTarget='/model-cache', pidsLimit=2048, ephemeralBytes=4 * GIB,
        healthCheck=health(8000, seconds=10, prepare=True))
    specs['ocr']['environment'].update(PYTHONPATH='/app', HF_HOME='/model-cache/huggingface', MODEL_NAME=profiles['ocr']['model'],
        MODEL_REVISION=profiles['ocr']['revision'], MODEL_LOCAL_FILES_ONLY='true', INFERENCE_MODE='vllm-dflash',
        TEAMAIBOX_HUNYUAN_SERVED_MODEL=profiles['ocr']['servedModel'],
        TEAMAIBOX_HUNYUAN_MODEL_MARKER='/model-cache/huggingface/hub/models--tencent--HunyuanOCR/snapshots/'
            + profiles['ocr']['revision'] + '/config.json',
        TEAMAIBOX_HUNYUAN_DFLASH_MARKER='/model-cache/hunyuanocr-dflash/config.json',
        DFLASH_MODEL_PATH='/model-cache/hunyuanocr-dflash', DFLASH_NUM_SPECULATIVE_TOKENS='15',
        MODEL_DEVICE='cuda:0', TORCH_DTYPE='bfloat16', VLLM_GPU_MEMORY_UTILIZATION='0.06',
        TEAMAIBOX_HUNYUAN_PREPARE_TIMEOUT_SECONDS='600', VLLM_USE_FLASHINFER_SAMPLER='0',
        VLLM_BATCH_WAIT_MILLISECONDS='0', VLLM_LOGGING_LEVEL='ERROR',
        VLLM_MAX_MODEL_LEN='8192', VLLM_MAX_NUM_BATCHED_TOKENS='8192', VLLM_TASK_CONCURRENCY='1')
    specs['drawing'].update(entrypoint=['python3'], command=['/runtime/flux2_bf16_protected_server.py'],
        ephemeralBytes=8 * GIB, cacheTargets=['/offload'], healthCheck=health(8000, seconds=1200, authenticated=True))
    drawing = read_json(Path(repository) / 'deploy/compute/flux2-klein-bf16-main-protected-profile.v1.json')
    specs['drawing']['environment'].update(drawing['runtime']['runtimeEnvironment'])
    specs['drawing']['environment'].update(TORCHINDUCTOR_CACHE_DIR='/offload/torchinductor',
        TEAMAIBOX_DRAWING_MODEL_REPOSITORY=profiles['drawing']['model'],
        TEAMAIBOX_DRAWING_MODEL_REVISION=profiles['drawing']['revision'])
    return dict(schemaVersion=1, profiles=profiles, workers=specs)


def bind(definition, installation_id, images, asset_paths):
    """Bind clean worker payloads to fresh named volumes and deterministic IDs.

    Payloads use the Node Agent's WorkerStartPayload contract; its compiled
    normalizer supplies start-spec digests before these are applied. No live
    profile IDs or named Docker volumes are adopted.
    """
    namespace = uuid.UUID(installation_id)
    need(set(definition['workers']) == set(definition['profiles']) == set(PROFILES), 'six office workers required')
    result = dict(profiles={}, workers={}, volumes={}, directories=[], apiEnvironment={})
    def identity(key):
        return str(uuid.uuid5(namespace, key))
    def volume(role, kind, source, readonly, target, uid):
        name = 'teamaibox-factory-' + identity('volume:' + role + ':' + kind)
        result['volumes'][name] = dict(source=str(source), readOnly=readonly, uid=uid, gid=uid)
        return dict(type='volume', source=name, target=target, readOnly=readonly)
    for index, (role, d) in enumerate(definition['workers'].items()):
        p = deepcopy(definition['profiles'][role])
        worker, profile = identity(role), identity('profile:' + role)
        uid = d['user']
        mounts = [volume(role, 'model', asset_paths[role + '-model'], True, d['modelTarget'], uid)]
        for i, target in enumerate(d['cacheTargets']):
            relative = 'office/cache/' + role + '/' + str(i)
            mounts.append(volume(role, 'cache-' + str(i), '@@DATA@@/' + relative, False, target, uid))
            result['directories'].append(dict(path=relative, uid=uid, gid=uid,
                                             mode='0700' if role == 'drawing' else '0750'))
        if role == 'drawing':
            mounts += [volume(role, 'runtime', asset_paths['drawing-runtime'], True, '/runtime', uid),
                       volume(role, 'auth', '@@DATA@@/office/auth/drawing', True, '/run/secrets/auth', uid)]
            result['directories'].append(dict(path='office/auth/drawing', uid=uid, gid=uid, mode='0700'))
        payload = dict(workerId=worker, attemptId=identity('attempt:' + role), modelProfileId=profile,
            workloadKind='compute-worker', image=images[role + '-worker'], network='compute-internal',
            limits={k: d[k] for k in ('memoryBytes', 'cpuQuotaMicros', 'pidsLimit', 'ephemeralBytes', 'sharedMemoryBytes', 'openFilesLimit')},
            security=dict(runAsUid=uid, runAsGid=uid, readOnlyRoot=True, noNewPrivileges=True, dropAllCapabilities=True,
                          privileged=False, hostPid=False, hostIpc=False, hostNetwork=False, dockerSocket=False),
            mounts=mounts, devices=['nvidia.com/gpu=all'] if d['gpu'] else [],
            environment=deepcopy(d['environment']), entrypoint=d['entrypoint'], command=d['command'],
            healthCheck=d['healthCheck'], tmpfsExecutable=d['tmpfsExecutable'],
            placementClass='protected-resident', maintenanceGeneration=1)
        payload['configDigest'] = 'sha256:' + hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        p.update(workerId=worker, modelProfileId=profile, stageOrder=index + 1, port=d['port'],
                 configurationDigest=payload['configDigest'], imageDigest=payload['image'],
                 dependsOnWorkerIds=[], placementClass='protected-resident', maintenanceGeneration=1)
        result['profiles'][role], result['workers'][role] = p, payload
        prefix = p['environmentPrefix']
        result['apiEnvironment'].update({prefix + '_PROFILE_ID': profile, prefix + '_PROFILE_KEY': p['profileKey'],
                                         prefix + '_WORKER_ID': worker})
    return result


def bind_retained_identity(normalized, state):
    # A reconnect advances the control generation, not the resident container.
    # Bind its original generation explicitly so existing read-only inspection
    # can recognize it without weakening mutation fencing.
    labels = normalized['createRequest']['Labels']
    expected = {'com.teamaibox.node-id': state['nodeId'],
                'com.teamaibox.node-generation': '1',
                'com.teamaibox.installation-id': state['installationId']}
    need(all(labels.get(k) == v for k, v in expected.items()), 'fresh worker ownership differs')
    normalized['target']['requiredLabels'].update(expected)


def prepare(root, definition, state, release, *, runner=run):
    """Create only this installation's empty caches and named volume bindings.

    Worker processes are deliberately not started in configuration. Policy
    normalization executes the shipped binary, so schema drift is detected
    before the platform or Node Agent is started.
    """
    assets = {v['role']: str(within(root / 'data', v['destination'])) for v in release['assets']}
    images = {v['role']: v['imageId'] for v in release['images']}
    value = bind(definition, state['installationId'], images, assets)
    binary = Path(assets['guest-host-tools']) / 'factory-worker-spec'
    need(binary.is_file() and os.access(binary, os.X_OK), 'factory worker normalizer is missing')
    targets = []
    for role, payload in value['workers'].items():
        profile = value['profiles'][role]
        request = dict(targetKey=profile['targetKey'], stageOrder=profile['stageOrder'], payload=payload,
                       installationId=state['installationId'], nodeId=state['nodeId'])
        result = subprocess.run([str(binary)], input=json.dumps(request), text=True, capture_output=True, timeout=15)
        need(result.returncode == 0, 'factory worker configuration rejected: ' + role)
        normalized = json.loads(result.stdout)
        need(normalized['target']['workerId'] == payload['workerId'], 'worker normalizer identity differs')
        bind_retained_identity(normalized, state)
        value['workers'][role] = normalized['payload']
        normalized['createRequest']['Labels']['com.teamaibox.service-role'] = role + '-worker'
        value.setdefault('createRequests', {})[role] = normalized['createRequest']
        targets.append(normalized['target'])
    for row in value['directories']:
        directory = within(root / 'data', row['path'])
        directory.mkdir(parents=True, exist_ok=True, mode=int(row['mode'], 8))
        os.chown(directory, row['uid'], row['gid'])
        os.chmod(directory, int(row['mode'], 8))
    # New drawing credential, not a copy of the release source's provider token.
    from factory_identity import secret_file
    secret_file(dict(name='drawing-provider', path='data/office/auth/drawing/provider.token',
                     format='base64url', bytes=32, mode='0400', uid=65532, gid=65532), root)
    for name, declaration in value['volumes'].items():
        source = declaration['source'].replace('@@DATA@@', str(root / 'data'))
        need(Path(source).is_relative_to(root / 'data') and Path(source).is_dir(), 'office volume source missing')
        declaration['source'] = source
        ensure_volume(name, source, state['installationId'], runner=runner)
    policy = dict(schemaVersion=1, targets=targets)
    policy_raw = (json.dumps(policy, indent=2) + '\n').encode()
    value['targetPolicy'], value['targetPolicyDigest'] = policy, 'sha256:' + hashlib.sha256(policy_raw).hexdigest()
    value['setId'] = 'factory-office-' + state['installationId']
    value['nodeId'] = state['nodeId']
    from factory_office_catalog import ALIASES, documents, fingerprint
    stamp = root / 'office-registration-time.json'
    if not stamp.exists():
        write_json(stamp, dict(installationId=state['installationId'],
            createdAt=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')))
    registration = read_json(stamp)
    need(registration['installationId'] == state['installationId'], 'office registration identity differs')
    value['documents'] = documents(value, release, state['installationId'], registration['createdAt'])
    for role, p in value['profiles'].items():
        prefix = p['environmentPrefix']
        p['fingerprint'] = fingerprint(value['documents'][role])
        value['apiEnvironment'].update({prefix + '_WORKER_ORIGIN': 'http://teamaibox-worker-' + p['workerId'] + ':' + str(p['port']),
            prefix + '_MODEL_ALIAS': ALIASES[role], prefix + '_SERVED_MODEL': p['servedModel'],
            prefix + '_PROFILE_FINGERPRINT': p['fingerprint'], prefix + '_ENGINE_IMAGE_DIGEST': p['imageDigest']})
    return value


def ensure_volume(name, source, installation_id, *, runner=run):
    """Named volumes make the installed Agent policy independent of host paths."""
    # Check absence separately; an arbitrary Docker failure is not absence.
    names = runner(['docker', 'volume', 'ls', '--format', '{{.Name}}']).splitlines()
    if name not in names:
        runner(['docker', 'volume', 'create', '--driver', 'local',
                '--label', 'com.teamaibox.installation-id=' + installation_id,
                '--opt', 'type=none', '--opt', 'o=bind', '--opt', 'device=' + source, name])
    rows = json.loads(runner(['docker', 'volume', 'inspect', name]))
    need(len(rows) == 1 and rows[0]['Name'] == name and rows[0]['Driver'] == 'local'
         and rows[0].get('Labels', {}).get('com.teamaibox.installation-id') == installation_id
         and rows[0].get('Options') == {'type': 'none', 'o': 'bind', 'device': source},
         'existing office volume differs; not adopted or changed: ' + name)

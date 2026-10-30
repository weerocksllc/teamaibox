"""Check declared clean model/guest resources before publishing a release.

Inventory hashes alone cannot detect a deliberately omitted model shard. These
checks read the model's own index and required entry points; no inference or
network request is made here.
"""
import json
from pathlib import Path
import re

from offline_common import need, read_json, within


def validate_asset(row, source):
    source = Path(source)
    role = row['role']
    names = {r['path'] for r in row['files']}
    need(len(names) == len(row['files']), 'duplicate asset file')
    for name in names:
        need(within(source, name).is_file(), 'declared artifact missing: ' + role + '/' + name)
    if role == 'factory-configuration' and 'factory.json' in names:
        recipe = read_json(source / 'factory.json')
        templates = [t for t in recipe['templates'] if t['output'] == recipe['composeFile']]
        need(len(templates) == 1, 'factory Compose template is ambiguous')
        compose = read_json(within(source, templates[0]['input']))
        api = compose.get('services', {}).get('platform-api', {}).get('environment', {})
        if api.get('DRAWING_WORKER_ORIGIN'):
            aliases = set(api.get('DRAWING_MODEL_ALIASES', '').split(','))
            need({'local/drawing-default', 'drawing.automatic', 'drawing.fast'} <= aliases,
                 'factory drawing UI routes are incomplete; regenerate factory configuration')
    # Do not ship guest/user state, private credentials or a whole runtime home.
    forbidden = {'.env', 'accounts.db', 'locksettings.db', 'cookies', 'login data', 'credentials.json'}
    for name in names:
        p = Path(name)
        need(p.name.lower() not in forbidden and not p.suffix.lower() in ('.key', '.qcow2', '.vhdx')
             and not {'.git', '.ssh', 'instances', 'cuttlefish_runtime'} & set(p.parts),
             'mutable/user material is not a release artifact: ' + role + '/' + name)
    if role.endswith('-model'):
        licenses = [f for f in row['files'] if Path(f['path']).name.lower() in
                    ('license', 'license.txt', 'license.md', 'licence', 'licence.txt')]
        need(licenses and all(f['size'] > 0 for f in licenses),
             'include the model license text before packaging: ' + role)
    if role in ('assistant-model', 'translation-model', 'embedding-model'):
        need({'config.json', 'tokenizer_config.json'} <= names and
             ('tokenizer.json' in names or 'tokenizer.model' in names), 'model configuration/tokenizer incomplete: ' + role)
        need(any(n.endswith(('.safetensors', '.bin')) for n in names), 'model weights missing: ' + role)
    if role == 'asr-model':
        need({'config.json', 'model.bin', 'tokenizer.json'} <= names, 'ASR model snapshot incomplete')
    if role == 'ocr-model':
        need('hunyuanocr-dflash/config.json' in names and
             any('/snapshots/' in n and n.endswith('/config.json') for n in names),
             'OCR model/draft layout incomplete')
        need(any('/snapshots/' in n and n.endswith('.safetensors') for n in names), 'OCR base weights missing')
        need(any(n.startswith('hunyuanocr-dflash/') and n.endswith('.safetensors') for n in names), 'OCR draft weights missing')
    if role == 'drawing-model':
        need('model_index.json' in names and any(n.endswith('.safetensors') for n in names), 'drawing pipeline incomplete')
        index = read_json(source / 'model_index.json')
        for component, value in index.items():
            if not component.startswith('_') and isinstance(value, list) and value and value[0] is not None:
                need(any(n.startswith(component + '/') for n in names), 'drawing component missing: ' + component)
    if role in ('android-standard', 'android-google'):
        # The clean ROM is inside the immutable runtime image, not a second
        # copy of a phone's mutable /phone directory. This sidecar binds its
        # release origin/notices to that exact image.
        need('manifest.json' in names and all(Path(n).name.lower().startswith(
             ('manifest.json', 'license', 'licence', 'notice', 'readme')) for n in names),
             'Android sidecar must contain release metadata/notices only')
        metadata = read_json(source / 'manifest.json')
        need(metadata.get('schemaVersion') == 1 and metadata.get('androidVersion') == '17'
             and metadata.get('baseBuildId') == '16102939'
             and re.fullmatch(r'sha256:[0-9a-f]{64}', metadata.get('runtimeImageId', ''))
             and metadata.get('systemFamily') == ('google-play' if role == 'android-google' else 'standard'),
             'Android sidecar identity incomplete')
    if role == 'computer-drivers':
        need(not any(n.lower().endswith('.iso') and n != 'virtio.iso' for n in names),
             'user/OS installation ISOs must not be included with drivers')
    for name in sorted(names):
        if name.endswith(('.safetensors.index.json', '.bin.index.json')):
            weights = read_json(source / name).get('weight_map')
            need(isinstance(weights, dict) and weights, 'empty model shard index: ' + name)
            for shard in set(weights.values()):
                target = (Path(name).parent / shard).as_posix()
                within(source, target)
                need(target in names, 'model shard omitted: ' + role + '/' + target)
    required = {
        'computer-firmware': {'CODE.fd', 'VARS.fd'},
        'computer-drivers': {'virtio.iso'},
        'guest-host-tools': {'phone-storage-helper', 'factory-worker-spec'},
        'drawing-runtime': {'flux2_bf16_protected_server.py'},
    }
    if role in required:
        need(required[role] <= names, 'runtime resources missing: ' + role)
    if role == 'guest-host-tools':
        for name in required[role]:
            with (source / name).open('rb') as f:
                header = f.read(20)
            need(header[:6] == b'\x7fELF\x02\x01' and header[18:20] == b'\xb7\x00', 'host helper is not Linux ARM64')
    return row


def validate_android_bindings(assets, images):
    """Match ROM sidecars to exported images before packaging can publish."""
    image_map = {row['role']: row['imageId'] for row in images}
    for row in assets:
        if row['role'] in ('android-standard', 'android-google'):
            role = 'phone-google-runtime' if row['role'] == 'android-google' else 'phone-runtime'
            actual = read_json(Path(row['source']) / 'manifest.json')
            need(actual['runtimeImageId'] == image_map[role], 'Android sidecar does not match release image')

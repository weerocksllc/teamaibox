"""Finish an interrupted cache-only manifest/configuration checkpoint under the boot lock."""
import json
import os
from pathlib import Path


def atomic_json(path, value):
    temporary = path.with_suffix(path.suffix + '.new')
    with temporary.open('w') as stream:
        os.fchmod(stream.fileno(), 0o600)
        json.dump(value, stream, indent=2)
        stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    temporary.replace(path)
    fd = os.open(path.parent, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)


def finish(configuration, manifest):
    journal = configuration.with_suffix('.cache-checkpoint.json')
    if not journal.exists(): return
    value = json.loads(journal.read_text())
    if value['configurationPath'] != str(configuration) or value['manifestPath'] != str(manifest):
        raise RuntimeError('cache_checkpoint_path_mismatch')
    atomic_json(manifest, value['manifest'])
    atomic_json(configuration, value['configuration'])
    journal.unlink()


def commit(configuration, manifest, config_value, manifest_value):
    atomic_json(configuration.with_suffix('.cache-checkpoint.json'), dict(configurationPath=str(configuration),
        manifestPath=str(manifest), configuration=config_value, manifest=manifest_value))
    finish(configuration, manifest)

#!/usr/bin/env python3
"""Materialize only the pinned, self-contained browser SDK and its license."""
import base64
import hashlib
import json
from pathlib import Path
import tarfile

ROOT = Path(__file__).resolve().parents[1]

def main():
    lock = json.loads((ROOT / 'deploy/casting/airplay-compatible-stack.lock.v2.json').read_text())['separateBrowserDelivery']
    archive = ROOT / 'apps/wireless-casting-plugin/vendor/livekit/livekit-client-2.21.0.tgz'
    raw = archive.read_bytes()
    assert 'sha256:' + hashlib.sha256(raw).hexdigest() == 'sha256:205a3d49070d350702dc44b6c20045c0cc2aae22f19117efa8ebea7375caf097'
    assert 'sha512-' + base64.b64encode(hashlib.sha512(raw).digest()).decode() == 'sha512-RBUhPkV/sl1nzl8lokVlK5uATPwn0AlsudCBZXissw/kDl9yz8ac4pNJ43iPpMVoHOeBYH/BZ3vUC1adqa/zFQ=='
    assert '205a3d49070d350702dc44b6c20045c0cc2aae22f19117efa8ebea7375caf097' in json.dumps(lock)
    destination = ROOT / 'apps/wireless-casting-plugin/src/public/vendor'
    destination.mkdir(exist_ok=True)
    files = {'package/dist/livekit-client.esm.mjs': 'livekit-client-2.21.0.esm.mjs',
             'package/LICENSE': 'livekit-client-LICENSE.txt', 'package/package.json': 'package.json'}
    results = {}
    with tarfile.open(archive) as tar:
        for source, target in files.items():
            member = tar.getmember(source)
            assert member.isfile() and member.size < 10 * 1024 * 1024
            content = tar.extractfile(member).read()
            if source.endswith('/LICENSE'):
                assert hashlib.sha256(content).hexdigest() == '09e8a9bcec8067104652c168685ab0931e7868f9c8284b66f5ae6edae5f1130b'
            if source.endswith('/package.json'):
                assert json.loads(content)['version'] == '2.21.0'
            path = destination / target
            if path.exists():
                assert path.read_bytes() == content, 'existing SDK differs; never overwrite it'
            else:
                with path.open('xb') as out:
                    out.write(content)
            results[target] = 'sha256:' + hashlib.sha256(content).hexdigest()
    print(json.dumps(results))

if __name__ == '__main__':
    main()

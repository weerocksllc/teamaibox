"""Derive browser-only boot configuration without exporting or changing keys.

The previous boot-local PKI remains the issuer for the unchanged SFU. Only the
new media and Platform configuration copies drop HDMI. No sessions are restored.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from casting_service_credentials import FILES, read_private, secure_directory, require_tmpfs
from casting_browser_only_container import successor_configuration

ROOT = Path('/run/teamaibox/casting')
RUN = re.compile(r'casting-browser-only-20[0-9]{6}-a[1-9][0-9]{0,3}')
def sha(b): return 'sha256:' + hashlib.sha256(b).hexdigest()
def canonical(v): return json.dumps(v, sort_keys=True, separators=(',', ':')).encode()

def derive(run_id, *, source, root=ROOT, owners=None):
    assert RUN.fullmatch(run_id)
    require_tmpfs(root)
    require_tmpfs(source)
    secure_directory(source, private=False)
    secure_directory(root, private=False)
    owners = owners or {s: u for s, (u, _) in FILES.items()}
    raw = read_private(source/'boot-manifest.json')
    manifest = json.loads(raw)
    assert manifest['schemaVersion'] == 1
    expected = {s+'/'+n for s, (_, names) in FILES.items() for n in names}
    assert set(manifest['files']) == expected
    data = {}
    for section, (_, names) in FILES.items():
        secure_directory(source/section, uid=owners[section])
        for name in names:
            key = section+'/'+name
            content = read_private(source/key, uid=owners[section])
            assert sha(content) == manifest['files'][key], 'boot_parent_changed'
            data[key] = content
    runtime, identity = successor_configuration(json.loads(data['media/runtime.json']),
                                                json.loads(data['platform/runtime-identity.json']))
    data['media/runtime.json'] = canonical(runtime)
    data['platform/runtime-identity.json'] = canonical(identity)
    receipt = dict(schemaVersion=1, sourceManifestDigest=sha(raw),
                   files={k:sha(v) for k,v in data.items()}, sessionRestored=False)
    destination = root/run_id
    if destination.exists():
        secure_directory(destination, private=False)
        assert json.loads(read_private(destination/'derivation.json')) == receipt
        assert {p.name for p in destination.iterdir()} == {*FILES, 'derivation.json'}
        for key, expected in data.items():
            assert read_private(destination/key, uid=owners[key.split('/')[0]]) == expected
        return dict(status='passed', alreadyPresent=True, runId=run_id, sessionRestored=False)
    temporary = Path(tempfile.mkdtemp(prefix='.browser-only-', dir=root))
    try:
        for section in FILES:
            folder = temporary/section
            folder.mkdir(mode=0o700)
            os.chown(folder, owners[section], owners[section])
        for key, content in data.items():
            with (temporary/key).open('xb') as f:
                f.write(content)
                os.fchmod(f.fileno(), 0o400)
                os.fchown(f.fileno(), owners[key.split('/')[0]], owners[key.split('/')[0]])
        with (temporary/'derivation.json').open('xb') as f:
            f.write(canonical(receipt)); os.fchmod(f.fileno(), 0o400)
        for section in FILES: (temporary/section).chmod(0o500)
        temporary.chmod(0o711)
        assert not destination.exists()
        os.rename(temporary, destination)
        temporary = None
    finally:
        for value in data.values():
            if isinstance(value, bytearray): value[:] = b'\0'*len(value)
        if temporary is not None:
            # Only files created in this owned temporary RAM directory.
            for section in FILES:
                folder = temporary/section
                if folder.exists():
                    folder.chmod(0o700)
                    for p in folder.iterdir(): p.unlink()
                    folder.rmdir()
            receipt_file = temporary/'derivation.json'
            if receipt_file.exists(): receipt_file.unlink()
            temporary.rmdir()
    return dict(status='passed', alreadyPresent=False, runId=run_id, sessionRestored=False)

if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--run-id', required=True)
    p.add_argument('--source', type=Path, required=True, help='explicit existing boot-local credential generation')
    try:
        args=p.parse_args()
        print(json.dumps(derive(args.run_id,source=args.source)))
    except Exception:
        print(json.dumps(dict(status='failed', failureCode='browser_boot_configuration_unavailable')))
        raise SystemExit(1)

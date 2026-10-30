"""Build-only extraction of the pinned upstream wheel, without pip or network."""
import base64
import csv
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import zipfile

root = Path('/tmp/camera-build')
lock = json.loads((root/'camera-decoder.lock.json').read_bytes())
raw = (root/'camera-decoder.whl').read_bytes()
assert len(raw) == lock['bytes'] and hashlib.sha256(raw).hexdigest() == lock['sha256']
target = Path('/opt/teamaibox/camera-python')
target.mkdir(mode=0o755)
with zipfile.ZipFile(io.BytesIO(raw)) as archive:
    items = archive.infolist()
    assert sum(i.file_size for i in items) < 100*1024**2
    assert len({i.filename for i in items}) == len(items)
    records = list(csv.reader(io.StringIO(archive.read('pillow-12.3.0.dist-info/RECORD').decode())))
    hashes = {path: (digest, size) for path, digest, size in records}
    assert len(hashes) == len(records)
    for item in items:
        path = PurePosixPath(item.filename)
        assert not path.is_absolute() and '..' not in path.parts
        assert path.parts[0] in ('PIL', 'pillow.libs', 'pillow-12.3.0.dist-info')
        assert (item.external_attr >> 16) & 0o170000 != 0o120000
        if item.is_dir():
            continue
        data = archive.read(item)
        expected, size = hashes[item.filename]
        if expected:
            assert expected == 'sha256='+base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b'=').decode()
            assert int(size) == len(data)
        else:
            assert item.filename == 'pillow-12.3.0.dist-info/RECORD'
        dest = target / item.filename
        dest.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        with dest.open('xb') as stream:
            stream.write(data)
        dest.chmod(0o444)
# Only build-owned public inputs are removed. License/RECORD remain in target.
for name in ('camera-decoder.whl', 'camera-decoder.lock.json', 'install_phone_camera_decoder.py'):
    (root/name).unlink()
root.rmdir()

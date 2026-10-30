#!/usr/bin/env python3
"""Read camera packages in the pristine ROM using an isolated tools container."""
import json
import re
import subprocess
import tempfile
import zipfile
from pathlib import Path
from gapps_image import extract


def main():
    with tempfile.TemporaryDirectory(prefix='camera-rom-') as scratch:
        root = Path(scratch)
        extract(Path('/opt/cuttlefish/super.img'), root, ['vendor_a'])
        vendor = root / 'vendor'
        subprocess.run(['fsck.erofs', '--extract=' + str(vendor), '--no-preserve-owner',
                        str(root / 'vendor_a.img')], check=True, capture_output=True)
        packages = []
        for path in sorted(vendor.rglob('*')):
            if not path.is_file():
                continue
            relative = str(path.relative_to(vendor))
            if 'camera' in relative.lower():
                item = {'path': relative, 'bytes': path.stat().st_size}
                if path.suffix in ('.rc', '.xml') and path.stat().st_size < 65536:
                    item['text'] = path.read_text(errors='replace')
                if path.suffix == '.apex':
                    with zipfile.ZipFile(path) as archive:
                        payload = root / (path.stem + '.img')
                        with payload.open('xb') as output:
                            output.write(archive.read('apex_payload.img'))
                    destination = root / path.stem
                    result = subprocess.run(['fsck.erofs', '--extract=' + str(destination),
                                             '--no-preserve-owner', str(payload)], capture_output=True)
                    if result.returncode != 0:
                        destination.mkdir(exist_ok=True)
                        result = subprocess.run(['debugfs', '-R', 'rdump / ' + str(destination),
                                                 str(payload)], capture_output=True)
                    item['payloadExtracted'] = result.returncode == 0
                    if result.returncode == 0:
                        item['files'] = [str(p.relative_to(destination)) for p in destination.rglob('*') if p.is_file()]
                        item['configs'] = {str(p.relative_to(destination)): p.read_text(errors='replace')
                                           for p in destination.rglob('*') if p.is_file() and
                                           (p.suffix == '.rc' or 'vintf' in str(p) and p.suffix == '.xml')}
                        item['transportStrings'] = {}
                        for library in destination.rglob('*.so'):
                            found = [s.decode('ascii') for s in re.findall(rb'[ -~]{6,}', library.read_bytes())
                                     if any(term in s.lower() for term in (b'vsock', b'camera_settings', b'camera_server_port', b'video_capture', b'v4l2', b'ignore device', b'external_camera_config'))]
                            if found:
                                item['transportStrings'][library.name] = found[:80]
                        item['cameraConfigFiles'] = {str(p.relative_to(destination)):p.read_text(errors='replace')
                                                    for p in destination.rglob('*') if p.is_file() and
                                                    p.suffix=='.xml' and 'camera' in p.name.lower() and p.stat().st_size<65536}
                packages.append(item)
        settings = {}
        for path in vendor.rglob('*'):
            if path.is_file() and path.stat().st_size < 131072 and path.suffix in ('.rc', '.prop', '.xml'):
                lines = [line for line in path.read_text(errors='replace').splitlines()
                         if 'camera' in line.lower() or 'apex' in line.lower() and 'select' in line.lower()]
                if lines:
                    settings[str(path.relative_to(vendor))] = lines
        configs={str(p.relative_to(vendor)):p.read_text(errors='replace') for p in vendor.rglob('*')
                 if p.is_file() and p.name=='external_camera_config.xml'}
        print(json.dumps({'androidStarted': False, 'cameraPackages': packages, 'settings': settings, 'externalConfigs':configs}, indent=2))


if __name__ == '__main__':
    main()

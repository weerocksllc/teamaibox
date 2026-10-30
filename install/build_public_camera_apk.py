#!/usr/bin/env python3
"""Build the preview fix using an explicitly supplied Android SDK and JDK.

The SDK is Google's public build dependency, not a runtime image. No emulator,
account or SDK user settings are copied. Output is a stock Camera2 APK with only
the source-defined methods changed and its original public AOSP test signer.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import urllib.request
import zipfile
from offline_common import digest, need, write_json

ROOT = Path(__file__).resolve().parents[1]
STOCK = '5888fe9106b4cd2d47a52a65f209e9464f77793b4477ff036c3797fdf44191d1'
CERT = 'a40da80a59d170caa950cf15c18c454d47a39b26989d8b640ecd745ba71bf5dc'


def build(stock, sdk, java, output, zipalign=None):
    need(not output.exists(), 'choose a new output directory')
    need(digest(stock) == STOCK, 'unexpected stock APK')
    bt = sdk / 'build-tools/36.1.0'
    zipalign = zipalign or bt/'zipalign'
    android = sdk / 'platforms/android-36.1/android.jar'
    cp = os.pathsep.join(str(v) for v in sorted((sdk / 'cmdline-tools/latest/lib').rglob('*.jar')))
    need(android.is_file() and (bt / 'd8').is_file() and cp and (java / 'bin/javac').is_file()
         and zipalign.is_file(),
         'requires Android SDK platform/build-tools 36.1 and command-line tools; pass --sdk and --java-home')
    output.mkdir(parents=True)
    def run(args):
        r = subprocess.run([str(v) for v in args], env={**os.environ, 'JAVA_HOME': str(java)},
                           capture_output=True, timeout=180)
        need(r.returncode == 0, Path(args[0]).name + ': ' + r.stderr.decode(errors='replace')[-2200:])
        return r.stdout.decode()
    src = ROOT / 'deploy/android/cuttlefish/camera-app'
    stubs = ROOT / 'tools/fixtures/camera-preview-patch-stubs'
    report = dict(status='building', stockSha256=STOCK, installed=False)
    try:
        need(CERT in run([bt / 'apksigner', 'verify', '--print-certs', stock]), 'not original AOSP test signer')
        with tempfile.TemporaryDirectory(prefix='camera-apk-', dir=output) as directory:
            p = Path(directory); classes = p / 'classes'; dex = p / 'dex'
            classes.mkdir(); dex.mkdir()
            run([java / 'bin/javac', '--release', '8', '-classpath', android, '-d', classes,
                 *sorted(src.glob('*.java')), *sorted(stubs.glob('com/**/*.java'))])
            run([bt / 'd8', '--min-api', '28', '--lib', android, '--output', dex, *sorted((classes / 'com').rglob('*.class'))])
            run([java / 'bin/javac', '--release', '8', '-classpath', cp, '-d', classes, stubs / 'PatchCameraDex.java'])
            with zipfile.ZipFile(stock) as z:
                (p / 'original.dex').write_bytes(z.read('classes.dex'))
            report['packaging'] = run([java / 'bin/java', '-cp', str(classes) + os.pathsep + cp,
                'PatchCameraDex', p / 'original.dex', dex / 'classes.dex', p / 'merged.dex']).strip()
            with zipfile.ZipFile(stock) as z, zipfile.ZipFile(p / 'unsigned.apk', 'w') as out:
                for item in z.infolist():
                    if not item.filename.upper().startswith('META-INF/'):
                        out.writestr(item, (p / 'merged.dex').read_bytes() if item.filename == 'classes.dex' else z.read(item))
            url = 'https://android.googlesource.com/platform/build/+/refs/heads/main/target/product/security/'
            for name in ('testkey.x509.pem', 'testkey.pk8'):
                with urllib.request.urlopen(url + name + '?format=TEXT', timeout=60) as response:
                    raw = base64.b64decode(response.read(), validate=True)
                (p / name).write_bytes(raw); (p / name).chmod(0o600)
            need(hashlib.sha256(ssl.PEM_cert_to_DER_cert((p / 'testkey.x509.pem').read_text())).hexdigest() == CERT,
                 'public AOSP signer changed')
            run([zipalign, '-f', '4', p / 'unsigned.apk', p / 'aligned.apk'])
            apk = output / 'Camera2.apk'
            run([bt / 'apksigner', 'sign', '--key', p / 'testkey.pk8', '--cert', p / 'testkey.x509.pem', '--out', apk, p / 'aligned.apk'])
            need(CERT in run([bt / 'apksigner', 'verify', '--print-certs', apk]), 'output signer changed')
            with zipfile.ZipFile(stock) as old, zipfile.ZipFile(apk) as new:
                for name in old.namelist():
                    if name != 'classes.dex' and not name.upper().startswith('META-INF/'):
                        need(old.read(name) == new.read(name), 'APK resource changed: ' + name)
            report.update(status='built', apkSha256=digest(apk), signerSha256=CERT, resourcesUnchanged=True)
    except Exception as error:
        report.update(status='failed', failure=str(error))
    write_json(output / 'camera-preview.json', report, 0o644)
    return report


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    for name in ('stock', 'sdk', 'java-home', 'output'):
        p.add_argument('--' + name, type=Path, required=True)
    p.add_argument('--zipalign',type=Path,help='native ARM64 zipalign, e.g. /usr/bin/zipalign from Ubuntu; defaults to SDK binary')
    a = p.parse_args()
    result = build(a.stock.resolve(), a.sdk.resolve(), a.java_home.resolve(), a.output.absolute(),
                   a.zipalign.resolve() if a.zipalign else None)
    print(json.dumps(result, indent=2))
    raise SystemExit(result['status'] == 'failed')

#!/usr/bin/env python3
"""Build the memory-only Camera2 recording fixture with the existing SDK, offline."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--sdk', type=Path, required=True)
    p.add_argument('--java-home', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    if a.output.exists():
        raise RuntimeError('output_occupied')
    source = ROOT/'tools/fixtures/phone-camera-record'
    build = a.sdk/'build-tools/36.1.0'; android = a.sdk/'platforms/android-36.1/android.jar'
    java = a.java_home/'bin'

    def command(args):
        r = subprocess.run([str(x) for x in args], capture_output=True, timeout=90,
                           env={**os.environ, 'JAVA_HOME':str(a.java_home)})
        if r.returncode:
            raise RuntimeError(Path(args[0]).name+': '+r.stderr.decode(errors='replace')[-3000:])

    with tempfile.TemporaryDirectory(prefix='phone-usb-fixture-') as temp:
        root = Path(temp); classes = root/'classes'; dex = root/'dex'; classes.mkdir(); dex.mkdir()
        command([java/'javac', '--release', '8', '-classpath', android, '-d', classes, source/'MainActivity.java'])
        command([build/'d8', '--min-api', '28', '--lib', android, '--output', dex, *sorted(classes.rglob('*.class'))])
        apk = root/'unsigned.apk'
        command([build/'aapt', 'package', '-f', '-M', source/'AndroidManifest.xml', '-I', android, '-F', apk])
        with zipfile.ZipFile(apk, 'a', compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(dex/'classes.dex', 'classes.dex')
        aligned = root/'aligned.apk'; key = root/'test.p12'
        command([build/'zipalign', '-f', '4', apk, aligned])
        command([java/'keytool', '-genkeypair', '-alias', 'fixture', '-keystore', key, '-storetype', 'PKCS12',
                 '-storepass', 'test-only-fixture', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '365',
                 '-dname', 'CN=Team AI Box no-recording USB test'])
        os.chmod(key, 0o600)
        command([build/'apksigner', 'sign', '--ks', key, '--ks-pass', 'pass:test-only-fixture', '--out', a.output, aligned])
        command([build/'apksigner', 'verify', a.output])
    print(json.dumps(dict(path=str(a.output.resolve()), sha256=hashlib.sha256(a.output.read_bytes()).hexdigest(),
                          permissions=['android.permission.CAMERA'], recordsMedia=False)))


if __name__ == '__main__':
    main()

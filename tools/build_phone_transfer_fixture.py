#!/usr/bin/env python3
"""Build a tiny no-permission test APK with an already installed Android SDK.

No Gradle, network download or host package installation. A temporary test-only
signing key is removed; only the public synthetic APK is retained.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

ROOT=Path(__file__).resolve().parents[1]


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--sdk',type=Path,required=True)
    p.add_argument('--java-home',type=Path,required=True)
    p.add_argument('--output',type=Path,required=True)
    args=p.parse_args()
    if args.output.exists(): raise ValueError('output_already_exists')
    build=args.sdk/'build-tools/36.1.0'; android=args.sdk/'platforms/android-36.1/android.jar'
    java=args.java_home/'bin'; source=ROOT/'tools/fixtures/phone-transfer-app'
    env=os.environ|{'JAVA_HOME':str(args.java_home)}
    def run(values):
        subprocess.run([str(v) for v in values],env=env,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=90)
    with tempfile.TemporaryDirectory(prefix='phone-fixture-build-') as temporary:
        root=Path(temporary); classes=root/'classes';dex=root/'dex';classes.mkdir();dex.mkdir()
        run([java/'javac','-source','8','-target','8','-bootclasspath',android,'-d',classes,source/'MainActivity.java'])
        run([build/'d8','--min-api','28','--output',dex,*sorted(classes.rglob('*.class'))])
        apk=root/'unsigned.apk'
        run([build/'aapt','package','-f','-M',source/'AndroidManifest.xml','-I',android,'-F',apk])
        with zipfile.ZipFile(apk,'a',compression=zipfile.ZIP_DEFLATED) as archive:
            archive.write(dex/'classes.dex','classes.dex')
        aligned=root/'aligned.apk';run([build/'zipalign','-f','4',apk,aligned])
        key=root/'fixture.p12'
        run([java/'keytool','-genkeypair','-alias','fixture','-keystore',key,'-storetype','PKCS12',
             '-storepass','test-only-fixture','-keyalg','RSA','-keysize','2048','-validity','365',
             '-dname','CN=Team AI Box synthetic phone test'])
        os.chmod(key,0o600)
        run([build/'apksigner','sign','--ks',key,'--ks-pass','pass:test-only-fixture','--out',args.output,aligned])
        run([build/'apksigner','verify','--verbose',args.output])
    print(json.dumps({'file':str(args.output.resolve()),'bytes':args.output.stat().st_size,
                      'sha256':hashlib.sha256(args.output.read_bytes()).hexdigest(),'syntheticOnly':True,'permissions':[]}))


if __name__=='__main__': main()

#!/usr/bin/env python3
"""Offline build using existing Android SDK/JDK; temporary signing key only."""
import argparse,hashlib,json,os,subprocess,tempfile,zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--sdk',type=Path,required=True);ap.add_argument('--java-home',type=Path,required=True);ap.add_argument('--output',type=Path,required=True);a=ap.parse_args()
    if a.output.exists():raise RuntimeError('output_occupied')
    source=ROOT/'tools/fixtures/phone-media-app';build=a.sdk/'build-tools/36.1.0';android=a.sdk/'platforms/android-36.1/android.jar';java=a.java_home/'bin'
    def command(args):subprocess.run([str(v) for v in args],env={**os.environ,'JAVA_HOME':str(a.java_home)},check=True,capture_output=True,timeout=90)
    with tempfile.TemporaryDirectory(prefix='phone-media-fixture-build-') as temp:
        p=Path(temp);classes=p/'classes';dex=p/'dex';classes.mkdir();dex.mkdir()
        command([java/'javac','-source','8','-target','8','-bootclasspath',android,'-d',classes,source/'MainActivity.java'])
        command([build/'d8','--min-api','28','--output',dex,*sorted(classes.rglob('*.class'))])
        apk=p/'unsigned.apk';command([build/'aapt','package','-f','-M',source/'AndroidManifest.xml','-I',android,'-F',apk])
        with zipfile.ZipFile(apk,'a',compression=zipfile.ZIP_DEFLATED) as z:z.write(dex/'classes.dex','classes.dex')
        aligned=p/'aligned.apk';command([build/'zipalign','-f','4',apk,aligned]);key=p/'fixture.p12'
        command([java/'keytool','-genkeypair','-alias','fixture','-keystore',key,'-storetype','PKCS12','-storepass','test-only-fixture','-keyalg','RSA','-keysize','2048','-validity','365','-dname','CN=Team AI Box synthetic media test'])
        os.chmod(key,0o600);command([build/'apksigner','sign','--ks',key,'--ks-pass','pass:test-only-fixture','--out',a.output,aligned]);command([build/'apksigner','verify',a.output])
    print(json.dumps(dict(path=str(a.output.resolve()),bytes=a.output.stat().st_size,sha256=hashlib.sha256(a.output.read_bytes()).hexdigest(),permissions=[],syntheticOnly=True)))
if __name__=='__main__':main()

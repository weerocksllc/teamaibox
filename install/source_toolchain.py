"""Prepare public build tools; does not replace Docker, NVIDIA or guest data."""
import json
import os
from pathlib import Path
import shutil
import subprocess
from urllib.request import urlopen
import xml.etree.ElementTree as ET
import zipfile
from offline_common import need, write_json
from source_download import download

GO = 'docker.io/library/golang@sha256:750c2fbc7cf8514249eaec73844b5ea96e32760b31adde66e1c93ac2fedc8166'
UBUNTU = 'docker.io/library/ubuntu@sha256:24737cef17f4e22b1977df7d9a05e77c4e28b7da5b8911f8d8ccda136bf3573c'


def safe_extract(archive, root):
    root.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as z:
        for item in z.infolist():
            path = root/item.filename
            need(path.resolve().is_relative_to(root.resolve()) and not item.filename.startswith('/')
                 and ((item.external_attr >> 16) & 0o170000) != 0o120000, 'unsafe SDK archive')
        z.extractall(root)
        for item in z.infolist():
            if not item.is_dir() and item.external_attr >> 16 & 0o111:
                (root/item.filename).chmod(0o755)


def prepare(output, cache, run):
    output.mkdir(parents=True, exist_ok=True)
    required = ['python3-yaml', 'git', 'jq', 'unzip', 'openjdk-17-jdk-headless', 'zipalign']
    missing = [p for p in required if subprocess.run(['dpkg-query','-W','-f=${Status}',p],
        capture_output=True).stdout != b'install ok installed']
    if missing:
        run(['apt-get','update'])
        run(['apt-get','install','-y','--no-install-recommends',*missing])
    run(['docker','pull','--platform=linux/arm64',GO])
    cid = subprocess.check_output(['docker','create','--entrypoint','true',GO],text=True).strip()
    try:
        run(['docker','cp',cid+':/usr/local/go',str(output/'go')])
    finally:
        run(['docker','rm',cid])
    # Publisher HTTPS metadata authenticates archive checksums. No mirror is
    # allowed to invent SDK hashes. Reuse the downloaded XML in this workspace.
    metadata = cache/'android-repository.xml'
    if not metadata.exists():
        with urlopen('https://dl.google.com/android/repository/repository2-3.xml',timeout=45) as response:
            metadata.write_bytes(response.read())
    root = ET.fromstring(metadata.read_bytes())
    for node in root.iter():
        node.tag = node.tag.rsplit('}',1)[-1]
    packages = {p.attrib['path']:p for p in root.findall('remotePackage')}
    selection = [('cmdline-tools;latest','cmdline-tools/latest'),
                 ('build-tools;36.1.0','build-tools/36.1.0'),('platforms;android-36.1','platforms/android-36.1')]
    sdk = output/'android-sdk'
    for package, destination in selection:
        need(package in packages, 'publisher SDK package is unavailable: '+package)
        archive = next((a for a in packages[package].findall('archives/archive')
                        if a.findtext('host-os') in (None,'linux')),None)
        need(archive is not None, 'Linux SDK archive missing')
        complete = archive.find('complete'); checksum = complete.find('checksum')
        name = complete.findtext('url')
        need(name and '/' not in name, 'unexpected SDK filename')
        file = download('https://dl.google.com/android/repository/'+name,
                        checksum.text.strip(), cache/name, checksum.attrib.get('type','sha1'))
        extracted = output/('extract-'+name)
        safe_extract(file, extracted)
        dirs = list(extracted.iterdir())
        need(len(dirs)==1 and dirs[0].is_dir(), 'unexpected SDK archive layout')
        target=sdk/destination; target.parent.mkdir(parents=True,exist_ok=True)
        shutil.move(str(dirs[0]),str(target))
    java = Path(shutil.which('javac')).resolve().parent.parent
    write_json(output/'tools.json',dict(go=str(output/'go/bin'),sdk=str(sdk),java=str(java),
                                     zipalign=shutil.which('zipalign')))

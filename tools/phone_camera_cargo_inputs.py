"""Public Cargo inputs via curl, then normal locked/offline Cargo compilation.

This temporary build helper only populates the run-private Cargo cache. It never
changes the user's Cargo cache, registry settings, credentials, proxy or routes.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import tomllib

REGISTRY='index.crates.io-1949cf8c6b5b557f'
EXISTING=Path.home()/'.cargo/registry'


def fetch_range(url, start, end, total, deadline):
    for attempt in range(3):
        seconds = min(45, int(deadline - time.monotonic()))
        if seconds < 1:
            raise RuntimeError('package_download_deadline')
        response = subprocess.run([
            'curl', '-fsSL', '--http1.1', '--connect-timeout', '10', '--max-time', str(seconds),
            '--max-filesize', str(end-start+1), '--range', f'{start}-{end}', '-D', '-',
            url + '?camera-range=' + str(start),
        ], capture_output=True, timeout=seconds+5)
        if response.returncode:
            continue
        raw = response.stdout
        # curl may emit a proxy CONNECT or redirect header before the final one.
        while raw.startswith(b'HTTP/'):
            header, separator, raw = raw.partition(b'\r\n\r\n')
            if not separator:
                raise RuntimeError('package_range_header_invalid')
            if b' 206 ' in header.split(b'\r\n', 1)[0]:
                expected = f'content-range: bytes {start}-{end}/{total}'.encode()
                if expected not in [line.lower().strip() for line in header.split(b'\r\n')]:
                    raise RuntimeError('package_range_mismatch')
                if len(raw) != end-start+1:
                    raise RuntimeError('package_range_truncated')
                return raw
        raise RuntimeError('package_range_not_partial')
    raise RuntimeError('package_range_download_failed')


def downloaded(url):
    for _ in range(1 if url.endswith('.crate') else 3):
        result=subprocess.run(['curl','-fsSL','--connect-timeout','10','--max-time','60','--max-filesize',str(32*1024**2),url],capture_output=True,timeout=65)
        if result.returncode==0:return result.stdout
    if url.endswith('.crate'):
        # Some public CDN transfers repeatedly stall mid-body. Retrieve exact
        # bounded ranges, then let Cargo.lock's checksum verify the whole crate.
        head=subprocess.run(['curl','-fsSI','--connect-timeout','10','--max-time','20',url],capture_output=True,timeout=25)
        lengths=re.findall(rb'(?im)^content-length:\s*(\d+)\s*$',head.stdout)
        if head.returncode==0 and lengths and 0<int(lengths[-1])<=32*1024**2:
            total=int(lengths[-1]);deadline=time.monotonic()+180;chunk=64*1024
            ranges=[(start,min(start+chunk,total)-1) for start in range(0,total,chunk)]
            with ThreadPoolExecutor(max_workers=4) as executor:
                return b''.join(executor.map(lambda pair:fetch_range(url,*pair,total,deadline),ranges))
    raise RuntimeError('public_cargo_input_download_failed')


def index_key(name):
    if not re.fullmatch('[a-z0-9_-]{1,64}',name):raise RuntimeError('crate_name_invalid')
    return str(len(name))+'/'+name if len(name)<3 else '3/'+name[0]+'/'+name if len(name)==3 else name[:2]+'/'+name[2:4]+'/'+name


def prepare(stage,previous=None):
    cargo=stage/'cargo';index=cargo/'registry/index'/REGISTRY
    index.mkdir(parents=True,exist_ok=True)
    # Offline Cargo can report misleading feature conflicts when a newer
    # version's transitive index is absent. Seed public metadata only, leaving
    # the user's registry and all account/config files untouched.
    existing_index=EXISTING/'index'/REGISTRY/'.cache'
    if existing_index.is_dir():
        shutil.copytree(existing_index,index/'.cache',dirs_exist_ok=True)
    if previous is not None:
        shutil.copytree(previous/'index'/REGISTRY/'.cache',index/'.cache',dirs_exist_ok=True)
    (index/'config.json').write_bytes(downloaded('https://index.crates.io/config.json'))
    seen=set();fresh=set()

    def add_index(name,refresh=False):
        key=index_key(name);target=index/'.cache'/key
        original=EXISTING/'index'/REGISTRY/'.cache'/key
        if original.is_file() and not refresh:
            raw=original.read_bytes()
        else:
            # Cargo 1.95 sparse-cache format, verified against this installed
            # Cargo's existing public cache. Cargo still resolves normally.
            rows=downloaded('https://index.crates.io/'+key).splitlines()
            raw=b'\x03\x02\0\0\0etag: "camera-build-input"\0'
            import json
            for line in rows:
                item=json.loads(line)
                if item['name'].lower()!=name:raise RuntimeError('registry_name_mismatch')
                raw+=item['vers'].encode()+b'\0'+line+b'\0'
            fresh.add(name)
        target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw);seen.add(name)

    environment=dict(os.environ,CARGO_HOME=str(cargo),CARGO_NET_OFFLINE='true')
    for _ in range(180):
        result=subprocess.run(['cargo','generate-lockfile','--offline'],cwd=stage/'workspace',env=environment,capture_output=True,timeout=30)
        if result.returncode==0:break
        error=result.stderr.decode(errors='replace')
        missing=re.search(r'no matching package named `([a-zA-Z0-9_-]+)`',error)
        requirement=re.search(r'failed to select a version for (?:the requirement )?`([a-zA-Z0-9_-]+)',error)
        if missing: name=missing.group(1).lower()
        elif requirement:name=requirement.group(1).lower()
        else:raise RuntimeError('offline_cargo_resolution_failed:'+error[-1800:])
        if name in fresh:raise RuntimeError('upstream_cargo_constraint_unsatisfied:'+name)
        add_index(name,refresh=name in seen)
    else:raise RuntimeError('cargo_dependency_count_exceeded')
    lock=tomllib.loads((stage/'workspace/Cargo.lock').read_text())
    packages=[p for p in lock['package'] if p.get('source')]
    if any(p['source']!='registry+https://github.com/rust-lang/crates.io-index' for p in packages):
        raise RuntimeError('unexpected_cargo_source')
    destination=cargo/'registry/cache'/REGISTRY;destination.mkdir(parents=True,exist_ok=True)

    def fetch_package(package):
        name,version=package['name'],package['version'];index_key(name.lower())
        if not re.fullmatch('[0-9A-Za-z.+_-]{1,100}',version):raise RuntimeError('crate_version_invalid')
        filename=name+'-'+version+'.crate';existing=EXISTING/'cache'/REGISTRY/filename
        if not existing.is_file() and previous is not None:
            existing=previous/'cache'/REGISTRY/filename
        raw=existing.read_bytes() if existing.is_file() else downloaded('https://static.crates.io/crates/'+name+'/'+filename)
        if hashlib.sha256(raw).hexdigest()!=package['checksum']:raise RuntimeError('cargo_crate_checksum_mismatch')
        (destination/filename).write_bytes(raw)
        return filename

    with ThreadPoolExecutor(max_workers=4) as executor:list(executor.map(fetch_package,packages))
    return dict(registry='crates.io',packageCount=len(packages),allCrateChecksumsVerified=True,
                indexCount=len(seen),freshIndexCount=len(fresh),offlineResolved=True)

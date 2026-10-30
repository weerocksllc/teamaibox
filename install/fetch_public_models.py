#!/usr/bin/env python3
"""Fetch immutable publisher model files, optionally verifying a local cache.

No installed model, account, Hugging Face token or browser profile is imported.
Quantized assistant/translation sources still need prepare_public_quantized.py.
All files are checked against the publisher's Git blob or LFS SHA-256 identity.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import re
import uuid
from urllib.parse import quote
from urllib.request import urlopen
from offline_common import need, read_json, relative, write_json

ROOT = Path(__file__).resolve().parents[1]
PROFILES = {
    'assistant-source': 'qwen38-main-protected-profile.v1.json',
    'translation-source': 'lmt4-protected-profile.v1.json',
    'embedding-model': 'qwen3-embedding-main-protected.v1.json',
    'drawing-model': 'flux2-klein-bf16-main-protected-profile.v1.json',
    'ocr-model': 'hunyuan-ocr-main-protected-profile.v1.json',
    'asr-model': 'asr-whisper-main-protected-profile.v1.json',
}
EXTENSIONS = {'.json', '.safetensors', '.bin', '.model', '.txt', '.jinja', '.py', '.md'}
ASR_LICENSE_URL = 'https://raw.githubusercontent.com/openai/whisper/v20250625/LICENSE'
ASR_LICENSE_SHA256 = 'b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d'
APACHE_LICENSE_URL = 'https://www.apache.org/licenses/LICENSE-2.0.txt'
APACHE_LICENSE_SHA256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'


def asr_license(output):
    # The converted model snapshot declares MIT but omits the standalone text.
    # Fetch the original model publisher's fixed release, never a live cache.
    from build_public_android import acquire
    acquire(ASR_LICENSE_URL, ASR_LICENSE_SHA256, output/'LICENSE')
    write_json(output/'license-provenance.json', dict(
        source=ASR_LICENSE_URL, sha256=ASR_LICENSE_SHA256,
        note='Original Whisper model license; converted weights retain MIT.'), 0o644)


def declared_apache_license(output, model_card, publisher):
    from build_public_android import acquire
    need(re.search(r'^license: apache-2\.0\s*$', model_card.read_text(), re.M),
         'publisher Apache-2.0 license declaration changed')
    acquire(APACHE_LICENSE_URL, APACHE_LICENSE_SHA256, output/'LICENSE')
    write_json(output/'license-provenance.json',dict(source=APACHE_LICENSE_URL,
        sha256=APACHE_LICENSE_SHA256,note='Apache-2.0 declared by the pinned '+publisher+' model card.'),0o644)


def translation_license(output, model_card):
    declared_apache_license(output,model_card,'NiuTrans')


def embedding_license(output, model_card):
    declared_apache_license(output,model_card,'Qwen embedding')


def selected(name):
    p = Path(relative(name))
    return (p.suffix in EXTENSIONS or p.name in ('LICENSE', 'NOTICE')) and not any(
        part in ('assets', 'examples', 'images', '.cache', '.git') for part in p.parts)


def runtime_file(role, name):
    if not selected(name):
        return False
    # Diffusers loads the component directories; the separate ComfyUI export
    # would duplicate the transformer. OCR uses 1.5, not the archived v1.0 tree.
    if role == 'drawing-model' and name.endswith('.safetensors') and '/' not in name:
        return False
    if role == 'ocr-model' and name.startswith('v1.0/'):
        return False
    return True


def identity(path, record):
    if not path.is_file() or path.is_symlink() or path.stat().st_size != record['size']:
        return False
    lfs = record.get('lfs')
    digest = hashlib.sha256() if lfs else hashlib.sha1()
    if not lfs:
        digest.update(('blob '+str(record['size'])+'\0').encode())
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8*1024**2), b''):
            digest.update(chunk)
    return digest.hexdigest() == (lfs['sha256'] if lfs else record['blobId'])


def destination_name(role, revision, name):
    relative(name)
    if role != 'ocr-model':
        return name
    if name.startswith('dflash/'):
        return 'hunyuanocr-dflash/'+name.removeprefix('dflash/')
    return 'huggingface/hub/models--tencent--HunyuanOCR/snapshots/'+revision+'/'+name


def range_download(url, row, directory, stream, workers=8):
    """Bounded HTTPS range transfer; full publisher hash is still mandatory."""
    from urllib.request import Request
    import time
    import threading
    size = row['size']; width = 16*1024**2
    folder = directory/row['lfs']['sha256'];folder.mkdir(parents=True,exist_ok=True)
    progress_lock = threading.Lock()
    received = 0
    last_report = time.monotonic()
    def received_range(count):
        nonlocal received, last_report
        with progress_lock:
            received += count
            now = time.monotonic()
            if now-last_report >= 30 or received == size:
                # Receipt/cache reuse is not the final publisher hash check.
                print(f"{row['rfilename']}: received {received}/{size} bytes (hash verification pending)", flush=True)
                last_report = now
    def chunk(start):
        end = min(size,start+width)-1
        path=folder/str(start)
        if path.is_file() and path.stat().st_size==end-start+1:
            received_range(end-start+1)
            return path
        for attempt in range(3):
            temporary=folder/(str(start)+'.partial')
            try:
                # Vary the query by range to avoid a proxy replaying a previous
                # signed redirect whose policy bound a different byte range.
                request=Request(url+'?download=true&range_start='+str(start),headers={'Range':f'bytes={start}-{end}'})
                with urlopen(request,timeout=120) as source, temporary.open('wb') as out:
                    need(source.status==206 and source.headers.get('Content-Range')==f'bytes {start}-{end}/{size}',
                         'publisher did not honor requested byte range')
                    shutil.copyfileobj(source,out,1024**2)
                need(temporary.stat().st_size==end-start+1,'truncated publisher range')
                temporary.replace(path)
                received_range(end-start+1)
                return path
            except Exception as error:
                if attempt==2: raise
                # A regional mirror can rate-limit new ranges. Honour its
                # cooldown rather than immediately flooding it with retries.
                from urllib.error import HTTPError
                delay = attempt + 1
                if isinstance(error, HTTPError) and error.code in (429, 503):
                    value = error.headers.get('Retry-After', '30')
                    delay = min(120, max(30, int(value) if value.isdigit() else 30))
                time.sleep(delay)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        chunks=list(pool.map(chunk,range(0,size,width)))
    for path in chunks:
        with path.open('rb') as source:shutil.copyfileobj(source,stream,8*1024**2)


def fetch(role, output, cache=None, resume=False, transfer='https', range_workers=8, endpoint='https://huggingface.co', file_workers=4):
    import fcntl
    output = Path(output).absolute()
    output.parent.mkdir(parents=True, exist_ok=True)
    lock_path = output.parent/('.'+role+'.download.lock')
    need(not lock_path.is_symlink(), 'model lock cannot be a symlink')
    with lock_path.open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return _fetch(role, output, cache, resume, transfer, range_workers, endpoint, file_workers)


def _fetch(role, output, cache=None, resume=False, transfer='https', range_workers=8, endpoint='https://huggingface.co', file_workers=4):
    need(1 <= range_workers <= 32, 'range workers must be between 1 and 32 per file')
    need(1 <= file_workers <= 4, 'file workers must be between 1 and 4')
    profile = read_json(ROOT/'deploy/compute'/PROFILES[role])['source']
    repo, revision = profile['model'], profile['revision']
    from public_model_git import endpoint as validate_endpoint, metadata as git_metadata
    endpoint = validate_endpoint(endpoint)
    if endpoint != 'https://huggingface.co':
        need(transfer != 'huggingface', 'alternate endpoints require the verified HTTPS/ranges transport')
        metadata = git_metadata(repo, revision, endpoint, output.absolute().parent/'.publisher-git-cache')
    else:
        url = endpoint+'/api/models/'+repo+'/revision/'+revision+'?blobs=true'
        with urlopen(url, timeout=60) as response:
            metadata = json.load(response)
    need(metadata['sha'] == revision, 'publisher revision differs')
    records = [row for row in metadata['siblings'] if runtime_file(role,row['rfilename'])]
    need(records and any(row['rfilename'].endswith(('.safetensors', '.bin')) for row in records), 'weights missing')
    output = output.absolute()
    need(not output.exists() or resume, 'choose a new output directory')
    if output.exists():
        prior = read_json(output/'publisher-inputs.json')
        need(prior['repository']==repo and prior['revision']==revision and
             prior['status'] in ('fetching','failed','publisher-files-verified'), 'only a matching download may resume')
    output.mkdir(parents=True, exist_ok=resume)
    report = dict(status='fetching', repository=repo, revision=revision, endpoint=endpoint,
                  files=[], privateDataUsed=False)
    write_json(output/'publisher-inputs.json', report, 0o644)

    def one(row):
        name = destination_name(role, revision, row['rfilename'])
        target = output/name
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            need(resume and identity(target,row), 'existing output differs: '+name)
            return dict(path=name,size=row['size'],gitBlob=row['blobId'],lfs=row.get('lfs'),reusedVerifiedCache=True)
        candidate = cache/name if cache else None
        reused = bool(candidate and identity(candidate, row))
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.download-', delete=False) as stream:
            temporary = Path(stream.name)
            try:
                if reused:
                    with candidate.open('rb') as source:
                        shutil.copyfileobj(source, stream, 8*1024**2)
                elif transfer == 'huggingface' and row.get('lfs'):
                    from huggingface_hub import hf_hub_download
                    downloaded = hf_hub_download(repo, row['rfilename'], revision=revision,
                        token=False, cache_dir=output.parent/'.publisher-download-cache')
                    with open(downloaded,'rb') as source:
                        shutil.copyfileobj(source,stream,8*1024**2)
                elif transfer == 'ranges' and row.get('lfs'):
                    download=endpoint+'/'+repo+'/resolve/'+revision+'/'+quote(row['rfilename'],safe='/')
                    range_download(download,row,output.parent/'.publisher-range-cache',stream,range_workers)
                else:
                    download = endpoint+'/'+repo+'/resolve/'+revision+'/'+quote(row['rfilename'], safe='/')
                    with urlopen(download, timeout=300) as source:
                        need(source.geturl().startswith('https://'), 'insecure download redirect')
                        shutil.copyfileobj(source, stream, 8*1024**2)
                stream.flush()
                if not identity(temporary, row):
                    if transfer == 'ranges' and row.get('lfs'):
                        chunks = output.parent/'.publisher-range-cache'/row['lfs']['sha256']
                        if chunks.exists():
                            chunks.rename(chunks.with_name(chunks.name+'.invalid-'+uuid.uuid4().hex))
                    raise RuntimeError('publisher checksum mismatch: '+name)
                temporary.chmod(0o644)
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
        print(role+': verified '+name, flush=True)
        return dict(path=name, size=row['size'], gitBlob=row['blobId'], lfs=row.get('lfs'), reusedVerifiedCache=reused)

    try:
        with ThreadPoolExecutor(max_workers=file_workers) as pool:
            report['files'] = list(pool.map(one, records))
        # The install contract also requires a top-level license for OCR.
        if role == 'ocr-model':
            license_file = output/destination_name(role, revision, 'LICENSE')
            need(license_file.is_file(), 'publisher license is missing')
            shutil.copyfile(license_file, output/'LICENSE')
        if role == 'asr-model':
            from offline_common import digest
            asr_license(output)
            required=('config.json','model.bin','tokenizer.json','vocabulary.txt')
            write_json(output/'teamaibox-model-manifest.v1.json',dict(schemaVersion=1,
                repository=repo,revision=revision,files=[dict(path=n,sizeBytes=(output/n).stat().st_size,
                sha256=digest(output/n)) for n in required]),0o644)
        if role == 'translation-source':
            translation_license(output,output/'README.md')
        if role == 'embedding-model':
            embedding_license(output,output/'README.md')
        expected={destination_name(role,revision,row['rfilename']) for row in records}
        expected.add('publisher-inputs.json')
        if role=='ocr-model': expected.add('LICENSE')
        if role=='asr-model': expected.update(('teamaibox-model-manifest.v1.json','LICENSE','license-provenance.json'))
        if role in ('translation-source','embedding-model'): expected.update(('LICENSE','license-provenance.json'))
        # A process killed during transfer may leave its temporary file. Move
        # only our recognisable partials out of the publishable asset directory.
        quarantine=output.parent/'.interrupted-downloads'/uuid.uuid4().hex
        for path in output.rglob('*'):
            if not path.is_file() or path.relative_to(output).as_posix() in expected:
                continue
            need(path.name.startswith('.download-') or re.fullmatch(r'tmp[a-z0-9_]{8}',path.name),
                 'unexpected file in model output: '+path.relative_to(output).as_posix())
            target=quarantine/path.relative_to(output);target.parent.mkdir(parents=True,exist_ok=True)
            path.rename(target)
        report['status'] = 'publisher-files-verified'
    except Exception:
        report['status'] = 'failed'
        raise
    finally:
        write_json(output/'publisher-inputs.json', report, 0o644)
    return report


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--role', choices=PROFILES, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--cache', type=Path, help='read-only publisher cache; every reused file is rehashed')
    p.add_argument('--resume', action='store_true', help='resume matching interrupted output; existing files are rehashed')
    p.add_argument('--transfer', choices=('https','huggingface','ranges'), default='https',
                   help='optional official huggingface_hub/hf_xet transport for large weights; token use is disabled')
    p.add_argument('--range-workers',type=int,default=8,help='parallel ranges per file (1-32); up to four files download at once')
    p.add_argument('--endpoint', default='https://huggingface.co',
                   help='HTTPS model origin; alternate origins require pinned Git/LFS verification')
    p.add_argument('--file-workers', type=int, default=4)
    a = p.parse_args()
    result = fetch(a.role, a.output, a.cache, a.resume, a.transfer, a.range_workers, a.endpoint, a.file_workers)
    print(json.dumps(dict(status=result['status'], files=len(result['files']), role=a.role)))

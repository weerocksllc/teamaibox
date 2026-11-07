"""Build-scoped Docker mirror adapter. Never changes daemon or host routing.

Only digest-pinned Docker Hub references are rewritten. Docker validates their
manifest and layer digests. Mutable references are intentionally not mirrored.
Temporary Dockerfiles and the executable wrapper live in the build workspace.
"""
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit
from public_model_git import endpoint
from offline_common import digest, need

IMAGE = re.compile(r'(?<![\w./-])docker\.io/([\w./-]+)(?::[\w.-]+)?@sha256:([a-f0-9]{64})(?![a-f0-9])')
SHORT_IMAGE = re.compile(r'(?<![\w./-])([a-z0-9][a-z0-9_-]*)(?::[\w.-]+)?@sha256:([a-f0-9]{64})(?![a-f0-9])')
TAG_LOCKS = {
    'docker.io/library/golang:1.26': 'docker.io/library/golang@sha256:750c2fbc7cf8514249eaec73844b5ea96e32760b31adde66e1c93ac2fedc8166',
}
PUBLIC_ECR_PROJECTS = {'valkey/valkey': 'public.ecr.aws/valkey/valkey'}
_EMSDK_BUCKET = 'https://storage.googleapis.com/webassembly/emscripten-releases-builds/'
_EMSDK_INPUTS = (
    ('14767574a5c37ff9526a253a65ddbe0811cb3667-wasm-binaries-arm64.tar.xz',
     'linux/14767574a5c37ff9526a253a65ddbe0811cb3667/wasm-binaries-arm64.tar.xz',
     286124608, '2d03f8eb3f81dd94821658eefbb442a92b0b7601f4cfb08590590fd7bc467ef8'),
    ('node-v20.18.0-linux-arm64.tar.xz', 'deps/node-v20.18.0-linux-arm64.tar.xz',
     24884024, 'a9ce85675ba33f00527f6234d90000946c0936fb4fca605f1891bb5f4fe6fb0a'),
)


def emsdk_context(work):
    from fetch_public_models import range_download
    base = Path(work)/'penpot-emsdk'
    payload = base/'payload'
    need(not any(p.is_symlink() for p in (base,payload)), 'linked Emscripten cache')
    payload.mkdir(parents=True, exist_ok=True)
    for name, location, size, sha in _EMSDK_INPUTS:
        target = payload/name
        need(not target.is_symlink(), 'linked Emscripten input')
        if not target.exists():
            with tempfile.NamedTemporaryFile(dir=base, delete=False) as output:
                stage = Path(output.name)
                range_download(_EMSDK_BUCKET+location, {'rfilename':name,'size':size,'lfs':{'sha256':sha}},
                               base/'ranges',output,workers=8)
            need(stage.stat().st_size==size and digest(stage)==sha, 'Emscripten download SHA-256 mismatch')
            stage.replace(target)
        need(target.stat().st_size==size and digest(target)==sha, 'Emscripten cache SHA-256 mismatch')
    need({p.name for p in payload.iterdir()} == {row[0] for row in _EMSDK_INPUTS}, 'unexpected Emscripten build input')
    return payload


def registry_endpoint(value):
    parsed = urlsplit(value)
    origin = endpoint(parsed._replace(path='').geturl())
    namespace = parsed.path.rstrip('/')
    need(not namespace or re.fullmatch(r'(?:/[a-z0-9][a-z0-9_-]*)+', namespace),
         'registry mirror requires an HTTPS origin and an optional repository prefix')
    return origin + namespace


def rewrite(text, mirror):
    host = registry_endpoint(mirror).removeprefix('https://')
    for tag, locked in TAG_LOCKS.items():
        text = re.sub(re.escape(tag)+r'(?![\w.@:-])',locked,text)
    def replace_image(match):
        repo, sha = match.groups()
        ref = host+'/'+repo
        if host == 'public.ecr.aws/docker':
            ref = PUBLIC_ECR_PROJECTS.get(repo, ref)
        return ref+'@sha256:'+sha
    text=IMAGE.sub(replace_image, text)
    return SHORT_IMAGE.sub(lambda m: host+'/library/'+m[1]+'@sha256:'+m[2], text)


def main():
    real = os.environ['TEAMAIBOX_REAL_DOCKER']
    mirror = os.environ.get('TEAMAIBOX_REGISTRY_MIRROR')
    args = sys.argv[1:]
    args = [rewrite(arg, mirror) for arg in args] if mirror else args
    temporary = None
    try:
        if args and args[0] == 'build':
            explicit = next(((i, arg) for i, arg in enumerate(args)
                             if arg in ('-f', '--file') or arg.startswith('--file=')), None)
            inline = bool(explicit and explicit[1].startswith('--file='))
            index = (explicit[0] if inline else explicit[0] + 1) if explicit else None
            original = Path(args[index].split('=', 1)[1] if inline else args[index]) if index is not None else Path(args[-1])/'Dockerfile'
            text = original.read_text()
            # These recipes use the standard frontend only. Avoid an unpinned
            # external frontend fetch; do not rewrite any source file in place.
            text = re.sub(r'^#\s*syntax=docker/dockerfile:1\s*\n', '', text)
            text = rewrite(text, mirror) if mirror else text
            if original.name=='penpot-editor-source.Dockerfile' and '--target' in args and args[args.index('--target')+1]=='frontend-runtime':
                marker = '&& cd /opt/emsdk && ./emsdk install 4.0.6 && ./emsdk activate 4.0.6 && rm /tmp/emsdk.tar.gz'
                start = 'RUN curl -fL --retry 3 https://codeload.github.com/emscripten-core/emsdk/'
                need(text.count(marker)==1 and text.count(start)==1, 'Emscripten recipe no longer matches the locked inputs')
                assets = emsdk_context(os.environ['TEAMAIBOX_NETWORK_WORK'])
                args[1:1] = ['--build-context', 'penpot-emsdk='+str(assets)]
                if index is not None:
                    index += 2
                text = text.replace(start, 'RUN --mount=from=penpot-emsdk,target=/run/penpot-emsdk,readonly '+start[4:])
                names = ' '.join(row[0] for row in _EMSDK_INPUTS)
                text = text.replace(marker, '&& cd /opt/emsdk && mkdir -p downloads && cp /run/penpot-emsdk/*.tar.xz downloads/ '
                    '&& EMSDK_KEEP_DOWNLOADS=1 ./emsdk install 4.0.6 && ./emsdk activate 4.0.6 '
                    '&& (cd downloads && rm -- '+names+') && rm /tmp/emsdk.tar.gz')
            cache=os.environ.get('TEAMAIBOX_ASR_MODEL')
            if original.name=='realtime-asr-cpu-worker.Dockerfile' and cache:
                text=text.replace('RUN python /opt/teamaibox/build_model_snapshot.py',
                                  'COPY --from=public-asr-model / /opt/model')
                args[1:1]=['--build-context','public-asr-model='+cache]
                if index is not None:
                    index += 2
            if original.as_posix().endswith('services/speaker-diarization-worker/Public.Dockerfile'):
                origin=endpoint(os.environ.get('TEAMAIBOX_MODEL_ENDPOINT','https://huggingface.co'))
                # This download already checks a repository-pinned SHA-256.
                text=text.replace('https://huggingface.co/',origin+'/')
            with tempfile.NamedTemporaryFile(mode='w', prefix='Dockerfile-',
                    dir=os.environ['TEAMAIBOX_NETWORK_WORK'], delete=False) as out:
                out.write(text); temporary = Path(out.name)
            if index is not None:
                args[index] = '--file='+str(temporary) if inline else str(temporary)
            else:
                args[1:1] = ['-f', str(temporary)]
        return subprocess.call([real, *args])
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    raise SystemExit(main())

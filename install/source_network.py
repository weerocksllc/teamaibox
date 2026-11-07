"""Build-scoped Docker mirror adapter. Never changes daemon or host routing.

Only digest-pinned Docker Hub references are rewritten. Docker validates their
manifest and layer digests. Mutable references are intentionally not mirrored.
Temporary Dockerfiles and the executable wrapper live in the build workspace.
TEAMAIBOX_DESKTOP_IMAGE_RELAY optionally selects an operator-provided loopback
registry for the two Guacamole repositories when a general mirror lacks them.
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
DESKTOP_REPOS = frozenset({'guacamole/guacamole', 'guacamole/guacd'})
_EMSDK_BUCKET = 'https://storage.googleapis.com/webassembly/emscripten-releases-builds/'
_EMSDK_INPUTS = (
    ('14767574a5c37ff9526a253a65ddbe0811cb3667-wasm-binaries-arm64.tar.xz',
     'linux/14767574a5c37ff9526a253a65ddbe0811cb3667/wasm-binaries-arm64.tar.xz',
     286124608, '2d03f8eb3f81dd94821658eefbb442a92b0b7601f4cfb08590590fd7bc467ef8'),
    ('node-v20.18.0-linux-arm64.tar.xz', 'deps/node-v20.18.0-linux-arm64.tar.xz',
     24884024, 'a9ce85675ba33f00527f6234d90000946c0936fb4fca605f1891bb5f4fe6fb0a'),
)

CASTING_GIT = {
    'gstreamer-rs': ('https://gitlab.freedesktop.org/gstreamer/gstreamer-rs', '4e20c0caa0100421080f081065e51f9341ba4693'),
    'gtk-rs-core': ('https://github.com/gtk-rs/gtk-rs-core', 'ae5dabb51cedf4f32021ba861cdd69f6c5e60193'),
    'gtk4-rs': ('https://github.com/gtk-rs/gtk4-rs', '6e427d7afd0e2ba0248736c3907761506887fbeb'),
    'ffv1': ('https://github.com/rust-av/ffv1.git', 'bd9eabfc14c9ad53c37b32279e276619f4390ab8'),
    'flavors': ('https://github.com/rust-av/flavors', '833508af656d298c269f2397c8541a084264d992'),
}


def casting_git_context(text, cache):
    # Cargo.lock remains unchanged. Only these public Git repositories are
    # redirected, inside this build layer, to their checked shallow objects.
    need(cache.is_dir() and cache.resolve() == cache, 'invalid casting Git cache directory')
    need({p.name for p in cache.iterdir()} == {name+'.git' for name in CASTING_GIT},
         'casting Git cache must contain the exact locked repositories')
    for name, (_, revision) in CASTING_GIT.items():
        path=cache/(name+'.git')
        need(path.is_dir() and path.resolve()==path and not any(f.is_symlink() for f in path.rglob('*')),
             'linked casting Git cache rejected')
        need(not (path/'objects/info/alternates').exists(), 'casting Git cache must be self-contained')
        args=['git','-c','core.hooksPath=/dev/null','--git-dir',str(path)]
        observed=subprocess.check_output([*args,'rev-parse','HEAD'],text=True,timeout=15).strip()
        need(observed==revision,'casting Git cache revision differs: '+name)
        subprocess.run([*args,'fsck','--strict','--no-reflogs',revision],check=True,timeout=45)
    marker="RUN echo '78a29692305fa131cef236d5c22e061894f6cbc43f408d36df7bb2537cc10620"
    online = ("GIT_CONFIG_COUNT=2 GIT_CONFIG_KEY_0=http.version GIT_CONFIG_VALUE_0=HTTP/1.1 \\\n"
              "    GIT_CONFIG_KEY_1=url.https://github.com/GStreamer/gstreamer-rs.insteadOf \\\n"
              "    GIT_CONFIG_VALUE_1=https://gitlab.freedesktop.org/gstreamer/gstreamer-rs \\\n")
    need(text.count(marker)==1 and text.count(online)==1,'casting Git cache recipe changed')
    configs=['git config --global protocol.file.allow always']
    configs += ['git config --global url.file:///run/casting-git/'+name+'.git.insteadOf '+url
                for name,(url,_) in CASTING_GIT.items()]
    wrapper = "printf '%s\\n' '#!/bin/sh' 'if [ \"$1\" = fetch ]; then shift; set -- fetch --update-shallow \"$@\"; fi' 'exec /usr/bin/git \"$@\"' >/tmp/taib-cargo-bin/git"
    setup=' && '.join([*configs,'mkdir -p /tmp/taib-cargo-bin',wrapper,'chmod 0755 /tmp/taib-cargo-bin/git'])
    text=text.replace(marker,'RUN --mount=from=taib-casting-git,target=/run/casting-git,readonly '+marker[4:])
    return text.replace(online,setup+' && PATH=/tmp/taib-cargo-bin:$PATH ')


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


def rewrite(text, mirror=None, desktop_relay=None):
    host = registry_endpoint(mirror).removeprefix('https://') if mirror else None
    if desktop_relay:
        need(re.fullmatch(r'127\.0\.0\.1:[1-9][0-9]{0,4}', desktop_relay)
             and int(desktop_relay.split(':')[1]) <= 65535,
             'desktop image relay must be an explicit IPv4 loopback port')
    if host:
        for tag, locked in TAG_LOCKS.items():
            text = re.sub(re.escape(tag)+r'(?![\w.@:-])',locked,text)
    def replace_image(match):
        repo, sha = match.groups()
        if desktop_relay and repo in DESKTOP_REPOS:
            return desktop_relay+'/'+repo+'@sha256:'+sha
        if not host:
            return match[0]
        ref = host+'/'+repo
        if host == 'public.ecr.aws/docker':
            ref = PUBLIC_ECR_PROJECTS.get(repo, ref)
        return ref+'@sha256:'+sha
    text=IMAGE.sub(replace_image, text)
    return SHORT_IMAGE.sub(lambda m: host+'/library/'+m[1]+'@sha256:'+m[2], text) if host else text


def use_desktop_base(real, args, relay):
    # The Docker engine can pull the pinned manifest from IPv4 loopback, but
    # forcing BuildKit to re-fetch that same manifest requires TLS there. Use
    # the Docker engine's exact local digest after a verified pull instead.
    prefix = 'GUACAMOLE_IMAGE='+relay+'/guacamole/guacamole@sha256:'
    references = [arg.removeprefix('GUACAMOLE_IMAGE=') for arg in args
                  if arg.startswith(prefix) and re.fullmatch('[a-f0-9]{64}', arg[len(prefix):])]
    if not references:
        return args
    need(len(references)==1, 'ambiguous desktop base image')
    ref = references[0]
    check = subprocess.run([real, 'image', 'inspect', ref, '--format={{.Os}}/{{.Architecture}}'],
                           text=True, capture_output=True, timeout=30)
    if check.returncode or check.stdout.strip() != 'linux/arm64':
        subprocess.run([real, 'pull', '--platform=linux/arm64', ref], check=True, timeout=1200)
    return ['--pull=false' if arg == '--pull=true' else arg for arg in args]


def main():
    real = os.environ['TEAMAIBOX_REAL_DOCKER']
    mirror = os.environ.get('TEAMAIBOX_REGISTRY_MIRROR')
    desktop_relay = os.environ.get('TEAMAIBOX_DESKTOP_IMAGE_RELAY')
    args = sys.argv[1:]
    args = [rewrite(arg, mirror, desktop_relay) for arg in args] if mirror or desktop_relay else args
    temporary = None
    try:
        if args and args[0] == 'build':
            if desktop_relay:
                args = use_desktop_base(real, args, desktop_relay)
            explicit = next(((i, arg) for i, arg in enumerate(args)
                             if arg in ('-f', '--file') or arg.startswith('--file=')), None)
            inline = bool(explicit and explicit[1].startswith('--file='))
            index = (explicit[0] if inline else explicit[0] + 1) if explicit else None
            original = Path(args[index].split('=', 1)[1] if inline else args[index]) if index is not None else Path(args[-1])/'Dockerfile'
            text = original.read_text()
            # These recipes use the standard frontend only. Avoid an unpinned
            # external frontend fetch; do not rewrite any source file in place.
            text = re.sub(r'^#\s*syntax=docker/dockerfile:1\s*\n', '', text)
            text = rewrite(text, mirror, desktop_relay) if mirror or desktop_relay else text
            casting_cache=os.environ.get('TEAMAIBOX_CASTING_GIT_CACHE')
            if original.as_posix().endswith('deploy/casting/Public.Dockerfile') and casting_cache and Path(casting_cache).exists():
                text=casting_git_context(text,Path(casting_cache))
                args[1:1]=['--build-context','taib-casting-git='+casting_cache]
                if index is not None:
                    index += 2
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
                diarization=os.environ.get('TEAMAIBOX_DIARIZATION_CACHE')
                if diarization and Path(diarization).exists():
                    context=Path(diarization)
                    model=context/'model.gguf'
                    sha='0679cfeb1ce356d0dea9470b31274f4bfc7eb927497d82005483770666da998a'
                    need(context.resolve()==context and {f.name for f in context.iterdir()}=={'model.gguf'}
                         and not model.is_symlink() and model.is_file() and digest(model)==sha,
                         'diarization cache does not match the pinned public model')
                    text,n=re.subn(r'RUN curl[^\n]+\\\n[^\n]+diar_streaming_sortformer[^\n]+\\\n[^\n]+model\.gguf[^\n]*',
                        'COPY --from=taib-diarization-model /model.gguf /build/model.gguf\n'
                        + "RUN echo '"+sha+"  model.gguf' | sha256sum -c -",text)
                    need(n==1,'diarization Dockerfile no longer matches locked input')
                    args[1:1]=['--build-context','taib-diarization-model='+diarization]
                    if index is not None:
                        index+=2
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

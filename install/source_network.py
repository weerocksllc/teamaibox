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
from public_model_git import endpoint

IMAGE = re.compile(r'(?<![\w./-])docker\.io/([\w./-]+)(?::[\w.-]+)?@sha256:([a-f0-9]{64})(?![a-f0-9])')
SHORT_IMAGE = re.compile(r'(?<![\w./-])([a-z0-9][a-z0-9_-]*)(?::[\w.-]+)?@sha256:([a-f0-9]{64})(?![a-f0-9])')
TAG_LOCKS = {
    'docker.io/library/golang:1.26': 'docker.io/library/golang@sha256:750c2fbc7cf8514249eaec73844b5ea96e32760b31adde66e1c93ac2fedc8166',
}


def rewrite(text, mirror):
    host = endpoint(mirror).removeprefix('https://')
    for tag, locked in TAG_LOCKS.items():
        text = re.sub(re.escape(tag)+r'(?![\w.@:-])',locked,text)
    text=IMAGE.sub(lambda m: host+'/'+m[1]+'@sha256:'+m[2], text)
    return SHORT_IMAGE.sub(lambda m: host+'/library/'+m[1]+'@sha256:'+m[2], text)


def main():
    real = os.environ['TEAMAIBOX_REAL_DOCKER']
    mirror = os.environ.get('TEAMAIBOX_REGISTRY_MIRROR')
    args = sys.argv[1:]
    args = [rewrite(arg, mirror) for arg in args] if mirror else args
    temporary = None
    try:
        if args and args[0] == 'build':
            index = args.index('-f')+1 if '-f' in args else None
            original = Path(args[index]) if index else Path(args[-1])/'Dockerfile'
            text = original.read_text()
            # These recipes use the standard frontend only. Avoid an unpinned
            # external frontend fetch; do not rewrite any source file in place.
            text = re.sub(r'^#\s*syntax=docker/dockerfile:1\s*\n', '', text)
            text = rewrite(text, mirror) if mirror else text
            cache=os.environ.get('TEAMAIBOX_ASR_MODEL')
            if original.name=='realtime-asr-cpu-worker.Dockerfile' and cache:
                text=text.replace('RUN python /opt/teamaibox/build_model_snapshot.py',
                                  'COPY --from=public-asr-model / /opt/model')
                args[1:1]=['--build-context','public-asr-model='+cache]
                if index:
                    index += 2
            if original.as_posix().endswith('services/speaker-diarization-worker/Public.Dockerfile'):
                origin=endpoint(os.environ.get('TEAMAIBOX_MODEL_ENDPOINT','https://huggingface.co'))
                # This download already checks a repository-pinned SHA-256.
                text=text.replace('https://huggingface.co/',origin+'/')
            with tempfile.NamedTemporaryFile(mode='w', prefix='Dockerfile-',
                    dir=os.environ['TEAMAIBOX_NETWORK_WORK'], delete=False) as out:
                out.write(text); temporary = Path(out.name)
            if index:
                args[index] = str(temporary)
            else:
                args[1:1] = ['-f', str(temporary)]
        return subprocess.call([real, *args])
    finally:
        if temporary:
            temporary.unlink(missing_ok=True)


if __name__ == '__main__':
    raise SystemExit(main())

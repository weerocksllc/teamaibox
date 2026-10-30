#!/usr/bin/env python3
"""Build with existing workspace tools only; never trigger package installation."""
import argparse
import json
import re
import subprocess
from pathlib import Path
import build_web_release_artifact as web


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'phone-web-release-20[0-9]{6}-a[1-9][0-9]*', args.run_id):
        raise RuntimeError('invalid_run')
    folder = web.EVIDENCE_ROOT / args.run_id
    path = folder.with_suffix('.json')
    if folder.exists() or path.exists():
        raise RuntimeError('run_occupied')
    folder.mkdir()
    files = web.source_files()
    before = web.source_digest(files)
    result = dict(runId=args.run_id, status='failed', sourceDigest=before,
                  sourceFileCount=len(files), sources={__file__: web.digest(Path(__file__).read_bytes())},
                  commands=[], dependenciesInstalled=False, browserAccepted=False)
    commands = [['node_modules/.bin/tsc', '-b'], ['node_modules/.bin/vite', 'build'],
                ['node', 'tools/verify-bundle.mjs', 'dist']]
    try:
        for index, command in enumerate(commands):
            completed = subprocess.run(command, cwd=web.ROOT/'apps/web', text=True,
                                       capture_output=True, timeout=180)
            log = folder / f'build-{index}.txt'
            log.write_text(completed.stdout + completed.stderr)
            result['commands'].append(dict(command=command, exitCode=completed.returncode,
                log=str(log.relative_to(web.ROOT)), sha256=web.digest(log.read_bytes())))
            if completed.returncode:
                raise RuntimeError(f'build_step_{index}_failed')
        if before != web.source_digest(web.source_files()):
            raise RuntimeError('source_changed')
        payload = web.archive(web.ROOT/'apps/web/dist')
        artifact = folder/'web.tar.gz'
        with artifact.open('xb') as output:
            output.write(payload)
        result.update(status='passed', artifact=str(artifact.relative_to(web.ROOT)),
                      artifactDigest=web.digest(payload), artifactBytes=len(payload))
    except Exception as error:
        result['failure'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    result['completedAt'] = web.now()
    result['evidenceDigest'] = web.digest(json.dumps(result, sort_keys=True, separators=(',', ':')).encode())
    with path.open('x') as output:
        json.dump(result, output, indent=2)
    print(json.dumps({k: result[k] for k in ('runId', 'status', 'failure', 'artifactDigest') if k in result}))
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
"""Build the isolated Penpot MCP pilot from pinned source (does not deploy)."""
import argparse
import json
from pathlib import Path
import subprocess
import uuid
from offline_common import need, read_json, write_json
from prepare_penpot_source import prepare
from source_download import file_hash


def build(repository, cache, output, archive=None):
    repository, cache, output = map(lambda p: Path(p).absolute(), (repository, cache, output))
    need(not output.exists(), 'use a new build output; previous evidence is retained')
    need(not output.resolve().is_relative_to(repository.resolve()), 'build output must be outside checkout')
    need(not any(p.is_symlink() for p in (output, *output.parents)), 'symlink in build output')
    output.mkdir(parents=True)
    source = prepare(repository, cache, output / 'source', archive)
    recipe = repository / 'install/images/penpot-mcp-source.Dockerfile'
    tag = 'teamaibox-penpot-mcp-pilot:' + uuid.uuid4().hex
    identity = {'source': read_json(repository / 'deploy/penpot-source.lock.json'),
                'recipeSha256': file_hash(recipe), 'reference': tag, 'deployed': False}
    write_json(output / 'inputs.json', identity)
    with (output / 'build.log').open('xb') as log:
        result = subprocess.run(['docker', 'build', '--platform=linux/arm64',
                                 '--label', 'com.teamaibox.purpose=penpot-source-pilot',
                                 '--tag', tag, '--file', str(recipe), str(source / 'mcp')],
                                stdout=log, stderr=subprocess.STDOUT)
    need(result.returncode == 0, 'Penpot MCP pilot build failed; see build.log; no deployment performed')
    image = json.loads(subprocess.check_output(['docker', 'image', 'inspect', tag]))[0]
    need(image['Architecture'] == 'arm64' and image['Os'] == 'linux', 'incorrect pilot image platform')
    report = {**identity, 'status': 'pilot-built-not-release-accepted', 'imageId': image['Id']}
    write_json(output / 'images.json', report)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--archive', type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.repository, args.cache, args.output, args.archive), indent=2))

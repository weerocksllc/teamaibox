#!/usr/bin/env python3
"""Package verified corresponding source; never copy a working service or publish."""
import argparse
import gzip
import hashlib
import json
import os
import posixpath
from pathlib import Path
import shutil
import stat
import tarfile
import tempfile

from offline_common import need, read_json, write_json
from source_download import file_hash
from build_penpot_stack import ROOT, PATCH_INPUTS, ROLES, prepare_candidate, tree_digest
from prepare_penpot_source import prepare
from apply_opencode_transport_patch import apply as patch_opencode


# Exact reviewed build inputs, not directory globs or the current Git worktree.
BUILD_FILES = (
    'deploy/penpot-source.lock.json', 'deploy/opencode-penpot-transport.lock.json',
    'deploy/penpot-runtime-dependencies.lock.json',
    'install/build_penpot_native.py', 'install/source_penpot.py',
    'install/package_penpot_sources.py', 'install/build_penpot_stack.py',
    'install/prepare_penpot_source.py', 'install/apply_opencode_transport_patch.py',
    'install/offline_common.py', 'install/source_download.py',
    'install/PENPOT-DEVELOPMENT.md', 'LICENSE', 'LICENSES/MPL-2.0.txt',
    *('install/' + name for name in PATCH_INPUTS),
    *('install/images/' + name for name in sorted({v[0] for v in ROLES.values()})),
    'install/images/opencode-penpot-source.Dockerfile',
    'install/build_penpot_agent.py', 'install/build_public_services.py',
    'install/images/agent-penpot-runtime.Dockerfile',
    'deploy/agent/opencode-agent-sandbox-main.mjs',
    'services/agent-bridge/src/penpot-runtime-config.mjs',
    'services/agent-bridge/src/penpot-native-activation.mjs',
    'services/agent-bridge/src/opencode-bridge-http-server.mjs',
    'services/agent-bridge/src/workspace-file-operations.mjs',
    'services/agent-bridge/src/opencode-native-activity.mjs',
    'deploy/agent/opencode-bridge-main.mjs',
    'services/agent-bridge/src/penpot-runtime-credential.mjs',
    'services/agent-bridge/src/penpot-credential-transport.mjs',
    'services/agent-bridge/src/penpot-native-dispatch-plugin.mjs',
)


def inventory(root):
    root = Path(root)
    result = {}
    for path in sorted(root.rglob('*')):
        name = path.relative_to(root).as_posix()
        mode = path.lstat().st_mode
        need(not any(p in {'.git', 'node_modules', '__pycache__', '.runtime'} for p in path.relative_to(root).parts),
             'generated or private directory in corresponding source')
        if stat.S_ISDIR(mode):
            continue
        if stat.S_ISLNK(mode):
            need(path.resolve().is_relative_to(root.resolve()), 'source link escapes package')
            result[name] = {'kind': 'link', 'target': os.readlink(path)}
        else:
            need(stat.S_ISREG(mode), 'unsupported corresponding source entry')
            result[name] = {'kind': 'file', 'sha256': file_hash(path), 'executable': bool(mode & 0o111)}
    return result


def changes(before, after):
    return {name: {'before': before.get(name), 'after': after.get(name)}
            for name in sorted(set(before) | set(after)) if before.get(name) != after.get(name)}


def write_archive(tree, output):
    """Reproducible bytes, no host owners, timestamps or absolute paths."""
    with output.open('xb') as raw, gzip.GzipFile(filename='', fileobj=raw, mode='wb', mtime=0) as zipped:
        with tarfile.open(fileobj=zipped, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for name, record in inventory(tree).items():
                path = tree / name
                entry = tarfile.TarInfo('teamaibox-design-source/' + name)
                entry.mode = 0o755 if record.get('executable') else 0o644
                if record['kind'] == 'link':
                    entry.type, entry.linkname = tarfile.SYMTYPE, record['target']
                    archive.addfile(entry)
                else:
                    entry.size = path.stat().st_size
                    with path.open('rb') as source:
                        archive.addfile(entry, source)


def verify_archive(path):
    """Check every payload member before a distributor pairs it with binaries."""
    prefix = 'teamaibox-design-source/'
    with tarfile.open(path, 'r:gz') as archive:
        members = archive.getmembers()
        names = [member.name for member in members]
        need(len(names) == len(set(names)), 'duplicate corresponding-source member')
        need(all(name.startswith(prefix) and '..' not in Path(name).parts
                 and posixpath.normpath(name) == name and '\\' not in name for name in names),
             'unsafe corresponding-source member')
        manifest_member = archive.getmember(prefix + 'SOURCE-MANIFEST.json')
        need(manifest_member.isfile() and manifest_member.size <= 16 * 1024 * 1024, 'invalid source manifest')
        manifest = json.load(archive.extractfile(manifest_member))
        need(manifest.get('schema') == 'teamaibox-design-corresponding-source-v1', 'unknown source manifest')
        records = manifest['files']
        need(set(names) == {prefix + name for name in records} | {prefix + 'SOURCE-MANIFEST.json', prefix + 'README.txt'},
             'source package contains undeclared or missing files')
        for member in members:
            need(member.uid == member.gid == member.mtime == 0 and not member.uname and not member.gname,
                 'host metadata found in source package')
            record = records.get(member.name.removeprefix(prefix))
            if record is None:
                need(member.isfile(), 'source metadata must be a regular file')
            elif record['kind'] == 'link':
                need(member.issym() and member.linkname == record['target'], 'source link mismatch')
                target = member.linkname
                resolved = posixpath.normpath(posixpath.join(posixpath.dirname(member.name), target))
                need(not target.startswith('/') and '\\' not in target and resolved.startswith(prefix)
                     and (resolved in names or any(name.startswith(resolved + '/') for name in names)),
                     'source link escapes package or is missing')
            else:
                need(record['kind'] == 'file', 'unsupported source record')
                need(member.isfile() and member.mode == (0o755 if record['executable'] else 0o644), 'source mode mismatch')
                digest = hashlib.sha256()
                with archive.extractfile(member) as stream:
                    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
                        digest.update(chunk)
                need(digest.hexdigest() == record['sha256'], 'source payload hash mismatch')
        for name in ['penpot/LICENSE', 'opencode/LICENSE', 'integration/LICENSES/MPL-2.0.txt',
                     'integration/install/PENPOT-DEVELOPMENT.md']:
            need(name in records, 'required corresponding-source license or instructions missing')
        return manifest


def package(cache, output, opencode_source, archive=None):
    output = Path(output).absolute()
    need(not output.exists(), 'corresponding-source output must be new')
    need(not any(p.is_symlink() for p in (output, *output.parents)), 'symlink in source package output')
    need(not output.resolve().is_relative_to(ROOT.resolve()), 'source payload stays outside product checkout')
    need(not ROOT.resolve().is_relative_to(output.resolve()), 'source output cannot contain checkout')
    output.parent.mkdir(parents=True, exist_ok=True)
    # The same preparation functions used by the image builder are the only
    # source admission path. No service volume, user profile or prepared tree
    # supplied by a caller can be silently added to the payload.
    with tempfile.TemporaryDirectory(prefix='penpot-corresponding-', dir=output.parent) as temp:
        stage = Path(temp)
        original = prepare(ROOT, cache, stage / 'original', archive)
        build = stage / 'build'
        build.mkdir()
        state = {'schema': 'penpot-candidate-build-v1', 'sources': {}, 'images': {}}
        source, key = prepare_candidate(cache, build, state, archive)
        tree = stage / 'payload'
        tree.mkdir()
        opencode = patch_opencode(opencode_source, tree / 'opencode')
        shutil.copytree(source, tree / 'penpot', symlinks=True)
        for name in BUILD_FILES:
            path = ROOT / name
            need(path.is_file() and not any(p.is_symlink() for p in (path, *path.parents)),
                 'missing or unsafe reviewed build input: ' + name)
            target = tree / 'integration' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
            target.chmod(0o755 if path.stat().st_mode & 0o111 else 0o644)
        penpot_lock = read_json(ROOT / 'deploy/penpot-source.lock.json')
        native_lock = read_json(ROOT / 'deploy/opencode-penpot-transport.lock.json')
        payload = inventory(tree)
        manifest = {
            'schema': 'teamaibox-design-corresponding-source-v1',
            'published': False, 'releaseAccepted': False,
            'penpot': {'commit': penpot_lock['commit'], 'archiveSha256': penpot_lock['archiveSha256'],
                       'sourceKey': key, 'treeSha256': tree_digest(source),
                       'changes': changes(inventory(original), inventory(source)),
                       'license': 'MPL-2.0; preserve per-file and component notices'},
            'opencode': {'commit': native_lock['commit'], 'upstreamTree': native_lock['tree'],
                         'treeSha256': tree_digest(opencode), 'license': 'MIT',
                         'patch': read_json(opencode / 'teamaibox-transport-patch.json')},
            'files': payload,
        }
        write_json(tree / 'SOURCE-MANIFEST.json', manifest, 0o644)
        (tree / 'README.txt').write_text(
            'Team AI Box design corresponding source\n\n'
            'penpot/: exact modified covered source, including original licenses and notices.\n'
            'opencode/: modified native runtime source; no Web GUI is embedded by the build.\n'
            'integration/: pinned inputs, overlays, public source recipes and build guide.\n'
            'SOURCE-MANIFEST.json: upstream identities, modifications and file hashes.\n\n'
            'Build Penpot from penpot/ with the integration/install/images recipes.\n'
            'The MCP recipe uses penpot/mcp/ as context; the OpenCode recipe uses opencode/.\n'
            'Keep notices on redistribution. MIT does not relicense Penpot covered files.\n'
            'Language/runtime dependencies retain their licenses; this is corresponding source,\n'
            'not a complete offline dependency package or a claim of application readiness.\n')
        candidate = stage / 'corresponding-source.tar.gz'
        write_archive(tree, candidate)
        verify_archive(candidate)
        # Hard-link publication is atomic and refuses to overwrite a racing
        # output. Source and destination are on the same parent filesystem.
        os.link(candidate, output)
        return {'path': str(output), 'sha256': file_hash(output), 'bytes': output.stat().st_size,
                'sourceKey': key, 'sourceTreeSha256': manifest['penpot']['treeSha256'],
                'opencodeTreeSha256': manifest['opencode']['treeSha256'],
                'files': len(payload), 'published': False, 'releaseAccepted': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--opencode-source', type=Path, required=True)
    parser.add_argument('--archive', type=Path)
    args = parser.parse_args()
    print(json.dumps(package(args.cache, args.output, args.opencode_source, args.archive), indent=2))

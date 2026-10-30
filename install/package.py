#!/usr/bin/env python3
"""Build an offline release from explicit, pinned artifacts, never a live data dump."""
from __future__ import annotations

import argparse
import ast
import copy
import fcntl
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile

from offline_common import ASSET_ROLES, IMAGE_ROLES, PHASES, InstallError, atomic, digest, need, read_json, run, validate_factory, validate_release, verify_package, within, write_json
from artifact_validation import validate_asset, validate_android_bindings
from image_role import verify_application_role

INSTALL_FILES = ('install.sh', 'installer.py', 'offline_common.py', 'offline_host_packages.py', 'PACKAGE-README.md')
LEGAL_FILES = ('LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md',
               'LICENSES/GPL-3.0-only.txt', 'LICENSES/MPL-2.0.txt', 'LICENSES/Apache-2.0.txt', 'LICENSES/AGPL-3.0-only.txt',
               'docs/open-source/components.json', 'docs/open-source/dependencies.json',
               'docs/open-source/OWNERSHIP.md', 'docs/open-source/RELEASING.md')


def copy_legal_notices(repo, destination):
    """Shipping original MIT code must also ship its notice; third parties stay separate."""
    for name in LEGAL_FILES:
        source = within(repo, name)
        need(source.is_file(), 'license payload missing: ' + name)
        copy_file(source, destination / name)


def portable_header(info):
    # Do not distribute the packaging workstation's account name/UID or xattrs.
    info.uid = info.gid = 0
    info.uname = info.gname = 'root'
    info.pax_headers = {}
    return info


def publish(root, pending, final, archive, checksum):
    """Publish only a verified package; an output collision never overwrites.

    The checksum file is published last. Ordinary failures move newly published
    paths back into our private stage; a power failure leaves an incomplete
    output without the completion checksum and is refused on the next build.
    """
    checksum_path = archive.with_name(archive.name + '.sha256')
    staged_checksum = pending.with_name('package.sha256')
    atomic(staged_checksum, f'{checksum}  {archive.name}\n'.encode(), 0o644)
    fd = os.open(archive.parent, os.O_RDONLY | os.O_DIRECTORY)
    published = []
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        need(not any(p.exists() or p.is_symlink() for p in (final, archive, checksum_path)),
             'output already exists; existing release preserved')
        for source, destination in ((root, final), (pending, archive), (staged_checksum, checksum_path)):
            identity = (source.stat().st_dev, source.stat().st_ino)
            os.rename(source, destination)
            published.append((source, destination, identity))
        os.fsync(fd)
    except Exception:
        for source, destination, identity in reversed(published):
            info = destination.lstat()
            need((info.st_dev, info.st_ino) == identity and not source.exists(),
                 'publication interrupted; preserve output for inspection')
            os.rename(destination, source)
        raise
    finally:
        os.close(fd)


def copy_file(source, destination, mode=0o644):
    need(source.is_file() and not source.is_symlink(), 'regular source file required: ' + str(source))
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source.open('rb') as src, destination.open('xb') as dst:
        shutil.copyfileobj(src, dst, 4 * 1024 * 1024)
    destination.chmod(mode)


def module_closure(repo, paths):
    """Include sibling Python imports; dynamic imports must be explicit inputs."""
    pending, result = list(paths), set()
    while pending:
        name = pending.pop()
        if name in result:
            continue
        path = within(repo, name)
        need(path.is_file(), 'runtime file missing: ' + name)
        result.add(name)
        if path.suffix != '.py':
            continue
        for node in ast.walk(ast.parse(path.read_text())):
            names = [n.name for n in node.names] if isinstance(node, ast.Import) else [node.module or ''] if isinstance(node, ast.ImportFrom) else []
            for module in names:
                module_path = module.replace('.', '/') + '.py'
                candidates = (path.parent / module_path, repo / module_path,
                              repo / 'tools' / module_path, repo / 'install' / module_path)
                matches = {candidate.resolve() for candidate in candidates if candidate.is_file()}
                need(len(matches) <= 1, 'ambiguous bundled Python import: ' + module)
                for candidate in matches:
                    need(candidate.is_relative_to(repo), 'Python module escapes repository')
                    pending.append(candidate.relative_to(repo).as_posix())
    return sorted(result)


def export_images(rows, root, runner=run, image_cache=None):
    cached = {}
    if image_cache:
        cached_manifest = verify_package(image_cache)
        cached = {r['imageId']: within(image_cache, r['archive']) for r in cached_manifest['images']}
    exported = {}
    for row in rows:
        actual = json.loads(runner(['docker', 'image', 'inspect', row['reference']]))[0]
        need(actual['Id'] == row['imageId'] and actual['Architecture'] == 'arm64'
             and actual['Os'] == 'linux', 'local image does not match release: ' + row['role'])
        verify_application_role(row['role'], actual)
        image_id = row['imageId']
        if image_id not in exported:
            name = 'images/' + image_id.split(':')[1] + '.tar'
            target = root / name
            target.parent.mkdir(exist_ok=True)
            if image_id in cached:
                # Reuse only a completely verified earlier package. The exact
                # local ID/OS/architecture was still checked above, and the
                # newly published package receives its own full checksums.
                copy_file(cached[image_id], target)
            else:
                # Stream directly; never capture multi-gigabyte exports in RAM.
                with target.open('xb') as out:
                    runner(['docker', 'image', 'save', image_id], timeout=7200, stdout=out)
            need(target.stat().st_size > 0, 'empty image export')
            exported[image_id] = name
        row['archive'] = exported[image_id]
        row['unpackedBytes'] = actual['Size']
        row.pop('reference', None)


def inventory_asset(source, destination, role):
    source = Path(source).resolve()
    files = []
    for path in sorted(source.rglob('*')):
        need(not path.is_symlink(), 'asset contains symlink; materialize a clean release tree: ' + str(path))
        if path.is_dir():
            continue
        need(path.is_file(), 'asset contains non-regular file')
        files.append(dict(path=path.relative_to(source).as_posix(), size=path.stat().st_size, sha256=digest(path),
                          mode=0o755 if path.stat().st_mode & 0o111 else 0o644))
    need(files, 'asset directory is empty')
    return dict(role=role, source=str(source), destination=destination, files=files)


def build_space(config, output, runner=run):
    images = {}
    for row in config['images']:
        observed = json.loads(runner(['docker', 'image', 'inspect', row['reference']]))[0]
        need(observed['Id'] == row['imageId'] and observed['Architecture'] == 'arm64' and observed['Os'] == 'linux',
             'local image does not match release: ' + row['role'])
        images[row['imageId']] = observed['Size']
    assets = sum(item['size'] + 4096 for row in config['assets'] for item in row['files'])
    # Keep both the extracted payload and distributable tar. Source assets are
    # already charged against filesystem free space; do not count them again.
    needed = 2 * (assets + sum(images.values()) * 11 // 10 + 64 * 1024**2)
    existing = output
    while not existing.exists():
        existing = existing.parent
    need(shutil.disk_usage(existing).free >= needed,
         'insufficient packaging space: need at least ' + str(needed) + ' free bytes')
    return needed


def build(release_path, output, repo, runner=run, allow_working_tree=False, image_cache=None):
    release_path, repo, output = Path(release_path).resolve(), Path(repo).resolve(), Path(output).resolve()
    config = validate_release(read_json(release_path))
    for asset in config['assets']:
        if not Path(asset['source']).is_absolute():
            asset['source'] = str(release_path.parent / asset['source'])
    validate_android_bindings(config['assets'], config['images'])
    commit = runner(['git', '-C', repo, 'rev-parse', 'HEAD']).strip()
    need(commit == config['sourceCommit'], 'sourceCommit does not match checkout')
    runtime = module_closure(repo, config['runtimeFiles'])
    # Runtime is copied from the identified commit, not untracked local overrides.
    modified = []
    for name in sorted(set(runtime) | {'install/' + f for f in INSTALL_FILES} | set(LEGAL_FILES)):
        need(within(repo, name).is_file(), 'installer source file missing: ' + name)
        tracked = subprocess.run(['git', '-C', str(repo), 'ls-files', '--error-unmatch', name], capture_output=True)
        status = runner(['git', '-C', repo, 'status', '--porcelain', '--', name])
        if tracked.returncode != 0 or status:
            need(allow_working_tree, 'runtime input differs from source commit; use explicit --allow-working-tree for a candidate: ' + name)
            modified.append(name)
    build_space(config, output, runner)
    output.mkdir(parents=True, exist_ok=True)
    name = 'teamaibox-' + config['releaseId'] + '-linux-arm64'
    final, archive = output / name, output / (name + '.tar')
    need(not final.exists() and not archive.exists(), 'output already exists; choose a different release/output directory')
    stage = Path(tempfile.mkdtemp(prefix='.' + name + '-', dir=output))
    root = stage / name
    root.mkdir()
    try:
        manifest = copy.deepcopy(config)
        manifest['runtimeFiles'] = runtime
        manifest['workingTreeFiles'] = modified
        # Build-only sources can change an image without belonging to the
        # copied runtime closure. An explicitly requested working-tree build
        # must never be advertised as the unmodified release commit.
        manifest['candidate'] = bool(allow_working_tree or modified)
        for script in (f for f in INSTALL_FILES if f != 'PACKAGE-README.md'):
            source = within(repo, 'install/' + script)
            copy_file(source, root / script, 0o755 if script.endswith('.sh') else 0o644)
        copy_file(within(repo, 'install/PACKAGE-README.md'), root / 'README.zh-CN.md')
        copy_legal_notices(repo, root)
        for file in runtime:
            copy_file(within(repo, file), root / 'runtime' / file)
        for asset in manifest['assets']:
            src = Path(asset.pop('source'))
            if not src.is_absolute():
                src = release_path.parent / src
            src = src.resolve()
            validate_asset(asset, src)
            asset['packagePath'] = 'assets/' + asset['role']
            expected = {f['path'] for f in asset['files']}
            actual = {p.relative_to(src).as_posix() for p in src.rglob('*') if not p.is_dir()}
            need(actual == expected, 'asset inventory drift: ' + asset['role'])
            for item in asset['files']:
                original = within(src, item['path'])
                need(original.is_file() and original.stat().st_size == item['size'] and digest(original) == item['sha256'],
                     'asset input changed: ' + asset['role'] + '/' + item['path'])
                copy_file(original, root / asset['packagePath'] / item['path'], item.get('mode', 0o644))
            if asset['role'] == 'factory-configuration':
                validate_factory(read_json(src / 'factory.json'), expected, runtime)
        export_images(manifest['images'], root, runner, image_cache)
        packages = []
        for record in manifest.get('hostPackages', []):
            source = Path(record['source'])
            if not source.is_absolute():
                source = release_path.parent / source
            need(digest(source) == record['sha256'], 'host package checksum mismatch')
            fields = runner(['dpkg-deb', '-f', source, 'Package', 'Version', 'Architecture']).splitlines()
            metadata = dict(line.split(': ', 1) for line in fields)
            package = metadata['Package']
            need(metadata['Architecture'] in ('arm64', 'all'), 'host package architecture mismatch')
            need(not package.startswith(('docker', 'containerd', 'nvidia', 'libnvidia', 'cuda', 'linux-image', 'linux-headers')),
                 'host foundation replacement forbidden: ' + package)
            name_in_package = 'host-packages/' + source.name
            need(not (root / name_in_package).exists(), 'duplicate host package filename')
            copy_file(source, root / name_in_package)
            packages.append(dict(path=name_in_package, name=package, version=metadata['Version'], sha256=record['sha256']))
        manifest['hostPackages'] = packages
        files = {}
        for path in sorted(root.rglob('*')):
            if path.is_file():
                files[path.relative_to(root).as_posix()] = dict(size=path.stat().st_size, sha256=digest(path), mode=path.stat().st_mode & 0o777)
        manifest['files'] = files
        manifest['payloadBytes'] = sum(f['size'] for f in files.values())
        write_json(root / 'release.json', manifest, 0o644)
        sums = ''.join(f"{files[n]['sha256']}  {n}\n" for n in sorted(files)) + f'{digest(root / "release.json")}  release.json\n'
        atomic(root / 'checksums.sha256', sums.encode(), 0o644)
        verify_package(root)
        # PAX supports large model files. No compression avoids extra CPU/RAM.
        pending = stage / 'package.tar'
        with tarfile.open(pending, 'w', format=tarfile.PAX_FORMAT) as tar:
            tar.add(root, arcname=root.name, filter=portable_header)
        checksum = digest(pending)
        publish(root, pending, final, archive, checksum)
        return dict(status='built', releaseId=config['releaseId'], archive=str(archive), sha256=checksum,
                    bytes=archive.stat().st_size, installed=False)
    finally:
        # Only our newly created staging tree, never an input or existing output.
        shutil.rmtree(stage)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--repository', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--verify', type=Path, help='Verify an extracted package without installing')
    parser.add_argument('--inventory-asset', type=Path, help='Print a streaming file inventory for an explicit clean asset directory')
    parser.add_argument('--role')
    parser.add_argument('--destination')
    parser.add_argument('--allow-working-tree', action='store_true', help='Explicit candidate build; record modified runtime input hashes')
    parser.add_argument('--image-cache', type=Path, help='Reuse exact image archives from a verified extracted package; never reuse live state')
    parser.add_argument('--describe-contract', action='store_true', help='Print mandatory release roles and phases')
    args = parser.parse_args()
    if args.describe_contract:
        result = dict(schemaVersion=1, architecture='arm64', images=sorted(IMAGE_ROLES), assets=sorted(ASSET_ROLES),
                      phases=list(PHASES), imageIdentity='full sha256 content ID; Linux ARM64; no registry fallback')
    elif args.verify:
        manifest = verify_package(args.verify)
        result = dict(status='verified', releaseId=manifest['releaseId'], installed=False)
    elif args.inventory_asset:
        need(args.role and args.destination, '--role and --destination required')
        result = inventory_asset(args.inventory_asset, args.destination, args.role)
    else:
        need(args.release and args.output, '--release and --output required')
        result = build(args.release, args.output, args.repository, allow_working_tree=args.allow_working_tree,
                       image_cache=args.image_cache)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (InstallError, OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        raise SystemExit('Package failed: ' + str(error))

#!/usr/bin/env python3
"""Generate complete release inputs from explicit clean artifacts, never live state.

Run on the build machine, with PyYAML installed. Target install needs only the
system Python standard library. This command performs no Docker/service writes.
"""
import argparse
import json
from pathlib import Path
import re

from factory_recipe import emit, installation_steps, readiness
from offline_common import ASSET_ROLES, IMAGE_ROLES, digest, need, read_json, run, validate_release, within, write_json
from offline_host_packages import ROOT_PACKAGES
from package import inventory_asset
from artifact_validation import validate_asset, validate_android_bindings
from image_role import verify_application_role


def prepare(inputs, output, repository, command=run):
    inputs = Path(inputs).resolve(strict=True)
    config = read_json(inputs)
    output, repository = Path(output).absolute(), Path(repository).resolve(strict=True)
    need(not output.exists() and not any(p.is_symlink() for p in (output, *output.parents)),
         'release preparation needs a new output directory')
    need(config.get('schemaVersion') == 1, 'unsupported preparation input')
    commit = command(['git', '-C', repository, 'rev-parse', 'HEAD']).strip()
    need(config.get('sourceCommit') == commit, 'sourceCommit does not match checkout')
    need(isinstance(config.get('agentVersion'), str) and re.fullmatch(r'\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?', config['agentVersion']),
         'declare the Node Agent build version')
    images = config.get('images', {})
    need(set(images) == IMAGE_ROLES, 'image map must contain exactly the declared product roles')
    pinned = []
    for role, image in sorted(images.items()):
        need(re.fullmatch('sha256:[0-9a-f]{64}', image or ''), 'exact local image ID required: ' + role)
        actual = json.loads(command(['docker', 'image', 'inspect', image]))[0]
        need(actual['Id'] == image and actual['Os'] == 'linux' and actual['Architecture'] == 'arm64',
             'wrong local image architecture/identity: ' + role)
        verify_application_role(role, actual)
        pinned.append(dict(role=role, imageId=image, reference=image, architecture='arm64', unpackedBytes=actual['Size']))
    artifacts = config.get('assets', {})
    need(set(artifacts) == ASSET_ROLES - {'factory-configuration'}, 'clean asset map is incomplete')
    def source(value):
        path = Path(value)
        return path if path.is_absolute() else inputs.parent / path
    assets = []
    for role, row in sorted(artifacts.items()):
        need(set(row) == {'source', 'destination'}, 'asset needs only source/destination: ' + role)
        assets.append(validate_asset(inventory_asset(source(row['source']), row['destination'], role), source(row['source'])))
    validate_android_bindings(assets, pinned)
    collection = read_json(source(config['hostPackageCollection']))
    need(collection.get('status') == 'collected' and collection.get('os') == 'ubuntu:24.04',
         'complete ARM64 Ubuntu 24.04 host-tool collection required')
    packages = collection['hostPackages']
    need(packages, 'empty host package inventory')
    for row in packages:
        path = source(row['source']).resolve(strict=True)
        need(path.suffix == '.deb' and digest(path) == row['sha256'], 'host package changed')
        row['source'] = str(path)
    recipe, runtime = emit(repository, output / 'factory')
    assets.append(inventory_asset(output / 'factory', 'assets/factory', 'factory-configuration'))
    release = dict(schemaVersion=1, releaseId=config['releaseId'], sourceCommit=commit, architecture='arm64',
        agentVersion=config['agentVersion'], images=pinned, assets=assets, hostPackages=packages,
        guestSystems=config['guestSystems'],
        host=dict(os=['ubuntu:24.04'], commands=['docker', 'python3', 'openssl', 'cryptsetup', 'mkfs.ext4',
            'mount', 'findmnt', 'losetup', 'ip', 'lsusb', 'v4l2-ctl', 'qemu-img', 'iptables', 'modprobe'],
            requiredPackages=list(ROOT_PACKAGES), freeReserveBytes=config.get('freeReserveBytes', 16 * 1024**3)),
        runtimeFiles=runtime, steps=installation_steps(), readiness=readiness(recipe))
    validate_release(release)
    write_json(output / 'release-input.json', release, 0o644)
    return dict(status='prepared', release=str(output / 'release-input.json'), images=len(pinned), assets=len(assets),
                runtimeFiles=len(runtime), installed=False)


def template(path, repository):
    """A deliberately incomplete build-input checklist, never an installable release."""
    need(not path.exists(), 'input template already exists; preserved')
    write_json(path, dict(schemaVersion=1, releaseId='SET_RELEASE_ID',
        sourceCommit=run(['git', '-C', repository, 'rev-parse', 'HEAD']).strip(), agentVersion='1.0.0',
        images={role: 'SET_VERIFIED_LOCAL_ARM64_IMAGE_ID' for role in sorted(IMAGE_ROLES)},
        assets={role: dict(source='SET_CLEAN_ARTIFACT_DIRECTORY', destination='assets/' + role)
                for role in sorted(ASSET_ROLES - {'factory-configuration'})},
        hostPackageCollection='SET_HOST_PACKAGE_COLLECTION_JSON',
        guestSystems=dict(androidVersion='17', androidBaseBuildId='16102939',
                          cameraSources=['image', 'browser', 'video', 'usb', 'udp']),
        freeReserveBytes=16 * 1024**3), 0o644)
    return dict(status='input-checklist-created', path=str(path), readyToPackage=False)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument('--inputs', type=Path)
    group.add_argument('--template', type=Path, help='Write all required input roles; placeholders are never buildable')
    p.add_argument('--output', type=Path)
    p.add_argument('--repository', type=Path, default=Path(__file__).resolve().parents[1])
    args = p.parse_args()
    if args.inputs and not args.output:
        p.error('--output is required with --inputs')
    result = template(args.template, args.repository) if args.template else prepare(args.inputs, args.output, args.repository)
    print(json.dumps(result, ensure_ascii=False, indent=2))

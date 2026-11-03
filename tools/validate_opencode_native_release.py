#!/usr/bin/env python3
"""Validate the current native contract; release proof is explicit and external.

Default: source/configuration consistency only, never a runtime acceptance claim.
--evidence FILE: additionally require source-bound ARM64 upgrade observations.
Historical 1.18 receipts are neither imported nor accepted as current proof.
"""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import re
import sys

try:
    from tools import validate_opencode_upstream as upstream
    from tools.opencode_release_contract import canonical, digest_bytes, source_identity
except ModuleNotFoundError:
    import validate_opencode_upstream as upstream
    from opencode_release_contract import canonical, digest_bytes, source_identity

ROOT = Path(__file__).resolve().parents[1]

def require(value, message):
    if not value:
        raise ValueError(message)

def read(path):
    return json.loads(path.read_text())

def validate(root=ROOT, evidence=None):
    root = Path(root).resolve()
    # The upstream validator itself is public and does not import old receipts.
    if root == ROOT:
        upstream.load_and_validate()
    lock = read(root / 'architecture/opencode/upstream-lock.v1.json')
    gate = read(root / 'architecture/opencode/compatibility-gate.v2.json')
    contract_path = root / 'services/agent-bridge/opencode-native-contract.json'
    contract = read(contract_path)
    version = lock['upstream']['providedSource']['packageVersion']
    artifact = lock['runtimeArtifact']['digest']
    require(gate['schemaVersion'] == 2, 'historical gate is not a current release gate')
    require(contract['version'] == version, 'native API version does not match engine lock')
    api_digest = contract['api']['sha256']
    require(contract['commit'] == lock['upstream']['providedSource']['commit'], 'native API source commit differs from lock')
    require('sha256:' + contract['artifact']['sha256'] == artifact, 'native API artifact differs from lock')
    require(re.fullmatch(r'[0-9a-f]{64}', api_digest), 'native API source digest is invalid')
    adapter = (root / gate['adapterPath']).read_text()
    require(version in adapter and artifact in adapter and lock['adapterKey'] in adapter, 'adapter pin differs from engine lock')
    policy = read(root / 'deploy/agent/sandbox-policy.v1.json')['opencode']
    required = lock['runtimePolicy']
    require(policy['environment'] == required['requiredEnvironment'], 'policy environment differs from lock')
    require(policy['configTarget'] == required['configurationTarget'], 'managed configuration target differs from lock')
    require(required['configurationOwner'] == 'root:root' and required['configurationMode'] == '0444', 'managed configuration is not immutable')
    for relative in gate['engineRecipes']:
        recipe = (root / relative).read_text()
        require('ARG OPENCODE_VERSION=' + version in recipe, 'Docker engine version differs from lock: ' + relative)
        require(artifact.removeprefix('sha256:') in recipe, 'Docker artifact differs from lock: ' + relative)
    extension = read(root / 'deploy/agent/native-extensions/package.json')
    require(extension['dependencies']['@opencode-ai/plugin'] == version, 'native plugin SDK differs from engine')
    require(len(contract['operations']) == len({v['operation'] for v in contract['operations']}) == 188, 'native operation inventory is incomplete')
    source = source_identity(gate['sourceRoots'], root)
    result = {'valid': True, 'scope': 'source-contract', 'version': version, 'artifact': artifact, 'source': source, 'releaseAccepted': False}
    if evidence is not None:
        proof = read(Path(evidence))
        require(proof.get('schemaVersion') == 2 and proof.get('kind') == 'teamaibox.native-upgrade-acceptance', 'not current native upgrade evidence')
        require(proof.get('version') == version and proof.get('artifact') == artifact, 'runtime evidence version/artifact mismatch')
        require(proof.get('source') == source, 'runtime evidence does not bind this exact source')
        require(proof.get('architecture') == 'linux/arm64/v8', 'runtime evidence must be ARM64')
        require(proof.get('nativeApiSha256') == api_digest, 'runtime evidence native API mismatch')
        checks = proof.get('checks', {})
        require(set(checks) == set(gate['requiredReleaseChecks']) and all(v is True for v in checks.values()), 'runtime acceptance checks incomplete or failed')
        images = proof.get('images', {})
        require(set(images) == set(gate['requiredImageRoles']) and all(re.fullmatch(r'sha256:[0-9a-f]{64}', v) for v in images.values()), 'exact built/deployed image identities required')
        require(proof.get('sensitiveContentRetained') is False, 'acceptance summary must not retain credentials/content')
        unsigned = {k: v for k, v in proof.items() if k != 'evidenceDigest'}
        require(proof.get('evidenceDigest') == digest_bytes(canonical(unsigned)), 'acceptance summary digest mismatch')
        result.update(scope='source-and-arm64-upgrade', releaseAccepted=True, images=images)
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path)
    parser.add_argument('--require-release', action='store_true')
    args = parser.parse_args()
    if args.require_release and args.evidence is None:
        parser.error('--require-release requires --evidence from actual current ARM64 observations')
    try:
        print(json.dumps(validate(evidence=args.evidence), sort_keys=True))
    except (ValueError, KeyError, OSError) as error:
        print('OpenCode native release validation failed: ' + str(error), file=sys.stderr)
        return 1
    return 0

if __name__ == '__main__':
    raise SystemExit(main())

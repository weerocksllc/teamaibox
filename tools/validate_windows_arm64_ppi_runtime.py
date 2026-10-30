#!/usr/bin/env python3
"""Validate one diskless ARM PPI build; never infer Windows acceptance."""
import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SIGNER = 'CEACC9E15534EBABB82D3FA03353C9CEF108B584'


def validate(data, root=ROOT):
    assert re.fullmatch(r'windows-arm64-ppi-runtime-\d{8}-a[1-9]\d*', data['runId'])
    assert data['status'] == 'passed' and data['windowsTpmAccepted'] is False
    assert re.fullmatch(r'sha256:[0-9a-f]{64}', data['image'])
    assert data['budget'] == {'buildGiB': 2, 'cpus': 2, 'hostReserveGiB': 16}
    assert data['admission']['eligibleForBoundedLab'] is True
    probe = data['probe']
    assert probe['status'] == 'passed' and probe['windowsTpmAccepted'] is False
    assert probe['sourceVersion'] == '11.1.1'
    assert re.fullmatch(r'[0-9a-f]{64}', probe['sourceSha256'])
    assert probe['releaseSignerFingerprint'] == SIGNER
    assert probe['query-kvm'] == {'enabled': True, 'present': True}
    assert probe['query-tpm'][0]['model'] == 'tpm-tis'
    assert probe['qom-get'] is True
    assert probe['query-vnc']['enabled'] is True and probe['query-vnc']['host'] == '127.0.0.1'
    identities = lambda rows: sorted((x['id'], x['name'], x['image']) for x in rows)
    assert identities(data['before']['containersBefore']) == identities(data['after']['containersAfter'])
    assert data['existingWorkloadIdentitiesUnchanged'] is True
    required = {'deploy/windows-arm64-ppi/Dockerfile', 'deploy/windows-arm64-ppi/probe_ppi.py',
                'tools/build_windows_arm64_ppi_runtime.py', 'tools/collect_windows_arm64_inventory.py',
                'tools/build_windows_arm64_crb_runtime.py', 'tools/build_windows_arm64_runtime.py'}
    assert set(data['sources']) == required
    for relative, expected in data['sources'].items():
        assert hashlib.sha256((root / relative).read_bytes()).hexdigest() == expected, relative
    return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    raw = args.evidence.read_bytes()
    data = json.loads(raw)
    validate(data)
    print(json.dumps({'runId': data['runId'], 'strict': 'passed',
                      'evidenceSha256': hashlib.sha256(raw).hexdigest(), 'windowsTpmAccepted': False}))

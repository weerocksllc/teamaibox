#!/usr/bin/env python3
"""Check exact inventory/runtime evidence without turning it into Windows acceptance."""
import argparse
import hashlib
import json
from pathlib import Path


def validate(data):
    assert data['status'] == 'passed', 'run did not pass'
    assert data['windowsBootTested'] is False, 'this validator is only for prerequisite probes'
    if 'nodes' in data:
        assert len(data['nodes']) == 2
        selected = next(n for n in data['nodes'] if n['host'] == data['selectedHost'])
        assert selected['assessment']['eligibleForBoundedLab'] is True
        assert selected['kvmApi'] == 12 and selected['architecture'] == 'aarch64'
        for node in data['nodes']:
            assert node['containersBefore'] == node['containersAfter'], 'workload drift'
            assert len(node['samples']) == 4
        assert not data['temporaryDiskPlan']['reusePhoneDisk']
        assert not data['temporaryDiskPlan']['created']
    else:
        assert data['probe']['status'] == 'passed'
        assert data['probe']['query-kvm'] == {'enabled': True, 'present': True}
        assert data['probe']['windowsBootTested'] is False
        assert data['before']['containersBefore'] == data['after']['containersAfter'], 'workload drift'
        assert data['probe']['firmware'], 'no firmware'
        assert data['image'].startswith('sha256:') and len(data['image']) == 71
    return True


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', required=True, type=Path)
    args = parser.parse_args()
    validate(json.loads(args.evidence.read_text()))
    print(json.dumps({'status': 'passed', 'evidence': str(args.evidence),
                      'sha256': hashlib.sha256(args.evidence.read_bytes()).hexdigest(),
                      'windowsAccepted': False}))

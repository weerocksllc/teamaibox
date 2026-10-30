#!/usr/bin/env python3
"""Release prerequisites and per-installation drift are separate contracts."""
import argparse
import json
from pathlib import Path
import host_drift
from appliance_installation import execute, load
from appliance_network_identity import atomic_write


def compatible(snapshot, contract, capabilities):
    facts = dict(architecture=snapshot.get('architecture',{}).get('value'),os={k:snapshot.get('os',{}).get(k) for k in ('id','versionId')},
                 kernelRelease=snapshot.get('kernelRelease',{}).get('value'),
                 foundation={k:snapshot.get('foundation',{}).get(k,{}).get('value') for k in ('docker','nvidiaContainerToolkit','nvidiaDriver')})
    failures = []
    if contract.get('version') != 1 or facts not in contract.get('combinations',[]): failures.append('unsupported_foundation_combination')
    for key in ('kvm','docker','cryptsetup','gpu'):
        if capabilities.get(key) is not True: failures.append('missing_'+key)
    return {'status':'compatible' if not failures else 'incompatible','failures':failures,'facts':facts}


def baseline(snapshot, installation_id):
    return dict(schemaVersion=1,installationId=installation_id,hostInstallPolicy='deny-unregistered',
        baseline=dict(architecture=snapshot['architecture']['value'],os={k:snapshot['os'][k] for k in ('id','versionId')},
        kernelRelease=snapshot['kernelRelease']['value'],foundation={k:v['value'] for k,v in snapshot['foundation'].items()},
        packageState=snapshot['packageState'],serviceState=snapshot['serviceState'],configurationFingerprints=snapshot['configurationFingerprints']))


def main():
    p=argparse.ArgumentParser();p.add_argument('--contract',required=True);p.add_argument('--installation',required=True)
    p.add_argument('--record-baseline');p.add_argument('--replace-baseline-digest')
    args=p.parse_args();installation=load(args.installation);snapshot=host_drift.capture_snapshot()
    capabilities={'kvm':Path('/dev/kvm').exists(),'docker':True,'cryptsetup':False,'gpu':False}
    try:execute(['cryptsetup','--version']);capabilities['cryptsetup']=True
    except RuntimeError:pass
    contract=json.loads(Path(args.contract).read_text())
    try:capabilities['gpu']=contract['hardware'] in execute(['nvidia-smi','--query-gpu=name','--format=csv,noheader'])
    except RuntimeError:pass
    result=compatible(snapshot,contract,capabilities)
    if result['status']!='compatible':print(json.dumps(result));raise SystemExit(2)
    if args.record_baseline:
        path=Path(args.record_baseline)
        if path.exists():
            import hashlib
            digest=hashlib.sha256(path.read_bytes()).hexdigest()
            if args.replace_baseline_digest!=digest:raise ValueError('existing_baseline_requires_explicit_previous_digest')
            old=json.loads(path.read_text())
            if old.get('installationId')!=installation['installationId']:raise ValueError('baseline_installation_mismatch')
            atomic_write(path.with_name(path.name+'.previous-'+digest[:12]),path.read_bytes(),0o600)
        atomic_write(path,(json.dumps(baseline(snapshot,installation['installationId']),indent=2)+'\n').encode(),0o600)
    print(json.dumps(result))


if __name__=='__main__':main()

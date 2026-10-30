"""Verify cache-only migration against retained originals, optionally reconcile exact boot hashes.

The repair flag is for the deployment bookkeeping normalization correction; it
cannot accept changed model arguments, images, limits or data mounts.
"""
import argparse
import fcntl
import json
from pathlib import Path
from ai_compilation_cache import inspect, verify_preserved, LABEL, need, boot, legacy
import ai_cache_checkpoint as checkpoint


def verify(configuration,manifest,stage,repair=False):
    config=json.loads(configuration.read_text()); document=json.loads(manifest.read_text())
    changes=json.loads((stage/'changes.json').read_text()); ids={c['current'] for c in changes}
    verified=[]
    for i,entry in enumerate(document['containers']):
        current=inspect(entry['id'])
        need(current['Id']==config['models'][i]['containerId'] and current['Name']=='/'+entry['name'] and current['Image']==entry['image'], 'cache_binding_changed')
        if entry['id'] in ids:
            original=json.loads((stage/f'model-{i}'/'parent.json').read_text())
            plan=json.loads((stage/f'model-{i}'/'plan.json').read_text())
            result=json.loads((stage/f'model-{i}'/'result.json').read_text())
            need(result['current']==entry['id'] and result['previous']==original['Id'],'cache_stage_identity_changed')
            verify_preserved(original,current,plan)
            digest=legacy.configuration_digest(current)
            if entry['configurationSha256']!=digest:
                need(repair,'cache_boot_hash_mismatch');entry['configurationSha256']=digest
            verified.append(dict(id=entry['id'],name=entry['name'],imageUnchanged=True,dataMountsUnchanged=True,
                healthy=current['State'].get('Health',{}).get('Status')=='healthy',cacheVolumes=[p['Source'] for p in plan]))
        else: legacy.validate_identity(current,entry)
    need(len(verified)==len(changes),'cache_stage_count_mismatch')
    if repair:
        raw=(json.dumps(document,indent=2)+'\n').encode();config['baseManifestSha256']=boot.digest(raw)
        checkpoint.commit(configuration,manifest,config,document)
    boot.load(configuration,manifest)
    return dict(status='passed',models=verified,bookkeepingReconciled=repair)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('configuration',type=Path);p.add_argument('manifest',type=Path);p.add_argument('stage',type=Path);p.add_argument('--repair-from-verified-originals',action='store_true');a=p.parse_args()
    with open('/run/lock/teamaibox-office-boot.lock','a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        print(json.dumps(verify(a.configuration,a.manifest,a.stage,a.repair_from_verified_originals)))

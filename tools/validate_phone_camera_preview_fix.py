#!/usr/bin/env python3
"""Exact test-phone preview geometry, not all-ROM/product acceptance."""
import argparse,hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1];E=ROOT/'evidence/validation/virtual-phones'
def need(ok,message):
    if not ok:raise RuntimeError(message)
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def source_check(record):
    for name,value in record['sources'].items():
        p=(ROOT/name).resolve();need(p.is_relative_to(ROOT),'source_path_invalid')
        need(digest(p)==value,'source_changed:'+name)
def validate(path):
    path=path.resolve();g=json.loads(path.read_bytes())
    need(path==E/(g['runId']+'.json'),'wrong_path')
    need(g['status']=='passed-synthetic-preview' and not g['productAccepted'] and not g['personalContentRecorded'],'scope_invalid')
    need(len(g['parents'])==1,'ready_parent_missing')
    name,h=next(iter(g['parents'].items()));ready_path=(ROOT/name).resolve()
    need(ready_path.parent==E and ready_path.name.endswith('-ready.json'),'ready_path_invalid')
    need(digest(ready_path)==h,'ready_changed');ready=json.loads(ready_path.read_bytes())
    final_path=E/(ready['runId']+'.json');final=json.loads(final_path.read_bytes())
    need(final['status']=='observed' and final['phoneStopped'] and not final.get('cleanupFailure'),'cleanup_incomplete')
    need(final['nodeBefore']==final['nodeAfter'],'office_services_changed')
    need(not final['guestDataDeleted'] and not final['googleCredentialsChanged'],'user_data_changed')
    for field in ('phoneId','containerId'):
        expected=ready['binding']['containerId'] if field=='containerId' else ready[field]
        need(g[field]==expected,'phone_identity_changed')
    need(final['binding']==ready['binding'] and g['apkSha256']==ready['apkInstalled']==final['apkInstalled'],'apk_binding_changed')
    build_path=E/'phone-camera-preview-build-20260914-a2.json';build=json.loads(build_path.read_bytes())
    need(digest(build_path)==ready['parentSha256']==final['parentSha256'],'build_parent_changed')
    need(build['status']=='built' and build['apkSha256']==g['apkSha256'] and digest(ROOT/build['output'])==g['apkSha256'],'build_invalid')
    need(build['manifestUnchanged'] and build['resourcesUnchanged'] and build['geometryTests']=='12 aspect/rotation cases and invalid dimensions passed','geometry_unit_tests_missing')
    need(build['signerSha256']=='a40da80a59d170caa950cf15c18c454d47a39b26989d8b640ecd745ba71bf5dc','stock_signature_changed')
    m=g['measurement'];c=m['previewCircle']
    need(m['syntheticOnly'] and not m['framesRecorded'] and not m['googleDataAccessed'] and m['stockControl'],'synthetic_scope_invalid')
    need(m['sourceFrames']>=150 and m['closed']['state']=='stopped','source_not_closed')
    need(c['width']>=100 and c['height']>=100 and abs(c['ratio']-c['width']/c['height'])<1e-9,'invalid_geometry')
    need(.98<=c['ratio']<=1.02 and .70<c['filledFraction']<.85,'preview_distorted')
    for record in (g,ready,final,build):source_check(record)
    return dict(valid=True,runId=g['runId'],evidenceSha256=digest(path),scope='one-test-phone-stock-camera-preview',
        circle=c,phoneStopped=True,guestDataPreserved=True,officeServicesUnchanged=True,
        allRomsPublished=False,endToEndLatencyAccepted=False,productAccepted=False)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--evidence',required=True,type=Path);a=p.parse_args();print(json.dumps(validate(a.evidence)))

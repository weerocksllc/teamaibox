"""Inventory and scan the already tested Windows UI image, without rebuilding it."""
import argparse,datetime as dt,json,re,subprocess,shutil
import appliance_container_operations as d
from appliance_operations import ssh
from maintenance_build_inputs import image_id, staging_directory, staging_root

SYFT='docker.io/anchore/syft@sha256:142a0f42f34a4bef64c15e1720c504ff3f2840ae6ce4d5bfd2b26948cbfac82a'
GRYPE='docker.io/anchore/grype@sha256:84a1e5435228172a0e56e8bfda49fa7ca62159f5eefcf7ae4b7851952e72315f'
def now():return dt.datetime.now(dt.timezone.utc).isoformat()
def dependency_packages(document):
 # Image identity and this repository's own version change for every UI build;
 # neither alters the installed operating-system/runtime dependency set.
 return sorted((p.get('name'),p.get('versionInfo'),p.get('supplier')) for p in document.get('packages',[])
  if p.get('name') not in {'sha256','@teamaibox/virtual-computers-plugin'})
def main():
 p=argparse.ArgumentParser();p.add_argument('--run-id',required=True);p.add_argument('--build',required=True)
 p.add_argument('--reuse-parent-release');p.add_argument('--staging-root',type=staging_root,required=True);a=p.parse_args()
 d.need(re.fullmatch(r'windows-computer-ui-release-\d{8}-a[1-9]\d*',a.run_id),'invalid_run')
 parent=d.ROOT/a.build;b=json.loads(parent.read_bytes());d.need(b['status']=='passed','build_failed');image_id(b['image'])
 d.need(all(d.sha((d.ROOT/f).read_bytes())==h for f,h in b['sources'].items()),'build_source_changed')
 path=d.ROOT/'evidence/validation/supply-chain'/(a.run_id+'.json');folder=path.with_suffix('');d.need(not path.exists() and not folder.exists(),'occupied');folder.mkdir()
 r=dict(runId=a.run_id,status='failed',startedAt=now(),architecture='linux/arm64/v8',imageConfigDigest=b['image'],
  sources=[dict(path=f,sha256='sha256:'+h) for f,h in b['sources'].items()],
  parent=dict(path=a.build,sha256='sha256:'+d.sha(parent.read_bytes())),servicesChanged=False)
 for source in ('tools/scan_windows_computer_ui.py','tools/maintenance_build_inputs.py'):
  r['sources'].append(dict(path=source,sha256='sha256:'+d.sha((d.ROOT/source).read_bytes())))
 try:
  for ref in [SYFT,GRYPE]:
   # Reuse an already present image only when the exact pinned digest resolves.
   # An offline main box must not fail merely because Docker tries to refresh a
   # scanner that is already available byte-for-byte.
   cached=subprocess.run(ssh(d.MAIN,['docker','image','inspect',ref]),capture_output=True,timeout=30)
   if cached.returncode!=0:
    d.run(d.MAIN,['docker','pull','--platform=linux/arm64',ref],timeout=240)
   i=json.loads(d.run(d.MAIN,['docker','image','inspect',ref]))[0];d.need(i['Architecture']=='arm64','wrong_scanner_architecture')
  common=['docker','run','--rm','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--memory=5g','--memory-swap=5g','--cpus=2','--pids-limit=64','--tmpfs','/tmp:rw,nosuid,nodev,size=4g,mode=1777']
  raw=d.run(d.MAIN,[*common,'--name',a.run_id+'-inventory','--network=none','-e','SYFT_CHECK_FOR_APP_UPDATE=false','-e','HOME=/tmp','-v','/var/run/docker.sock:/var/run/docker.sock',SYFT,'scan','docker:'+b['image'],'--output','spdx-json'],timeout=300)
  d.need(len(json.loads(raw).get('packages',[]))>0,'empty_sbom')
  with (folder/'ui.spdx.json').open('xb') as f:f.write(raw)
  stage=staging_directory(a.staging_root,a.run_id);d.run(d.MAIN,['mkdir','-m','0755',stage]);d.run(d.MAIN,['tee',stage+'/ui.spdx.json'],input=raw)
  print(json.dumps(dict(phase='inventory_complete')),flush=True)
  if a.reuse_parent_release:
   previous_path=d.ROOT/a.reuse_parent_release;previous=json.loads(previous_path.read_bytes())
   d.need(previous['status']=='passed' and previous['findings']['critical']==previous['findings']['high']==0,'parent_scan_failed')
   previous_folder=previous_path.with_suffix('');previous_sbom=json.loads((previous_folder/'ui.spdx.json').read_bytes())
   d.need(dependency_packages(previous_sbom)==dependency_packages(json.loads(raw)),'dependency_set_changed')
   previous_scan=json.loads((previous_folder/'ui.grype.json').read_bytes())
   d.need(previous_scan['descriptor']['name']=='grype' and previous_scan['descriptor']['db']['status']['valid'],'parent_scan_invalid')
   built=dt.datetime.fromisoformat(previous_scan['descriptor']['db']['status']['built'].replace('Z','+00:00'))
   d.need(dt.datetime.now(dt.timezone.utc)-built<dt.timedelta(hours=48),'parent_scan_stale')
   shutil.copyfile(previous_folder/'ui.grype.json',folder/'ui.grype.json')
   r['scanReuse']=dict(mode='identical-dependency-set',parent=str(previous_path.relative_to(d.ROOT)),
    parentSha256='sha256:'+d.sha(previous_path.read_bytes()),databaseBuiltAt=built.isoformat(),dependencyPackages=len(dependency_packages(previous_sbom)))
   scan=(folder/'ui.grype.json').read_bytes()
  else:
   scan=d.run(d.MAIN,[*common,'--name',a.run_id+'-scan','-e','GRYPE_DB_CACHE_DIR=/tmp/grype-db','-e','GRYPE_DB_UPDATE_DOWNLOAD_TIMEOUT=8m','-v',stage+':/work:ro',GRYPE,'sbom:/work/ui.spdx.json','--output','json'],timeout=600)
   with (folder/'ui.grype.json').open('xb') as f:f.write(scan)
  parsed=json.loads(scan);d.need(parsed['descriptor']['name']=='grype' and parsed['descriptor']['db']['status']['valid'],'invalid_scan')
  r['scannedAt']=now();r['findings']={key:sum(m['vulnerability']['severity'].lower()==key for m in parsed['matches']) for key in ['critical','high','medium','low','unknown']}
  r['artifacts']=[dict(path=str((folder/f).relative_to(d.ROOT)),sha256='sha256:'+d.sha((folder/f).read_bytes())) for f in ['ui.spdx.json','ui.grype.json']]
  d.need(r['findings']['critical']==r['findings']['high']==0,'scan_policy_exceeded');r['status']='passed'
 except Exception as e:r['failure']=str(e)[-1000:]
 r['completedAt']=now();r['evidenceDigest']='sha256:'+d.sha(d.canonical(r))
 with path.open('x') as f:json.dump(r,f,indent=2)
 print(json.dumps({k:r.get(k) for k in ['runId','status','findings','failure']}));return r['status']!='passed'
if __name__=='__main__':raise SystemExit(main())

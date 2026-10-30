#!/usr/bin/env python3
"""Switch only installed boot checks to the verified local volume configuration."""
import argparse
import json
import os
from pathlib import Path
from appliance_installation import load, execute
from install_portable_runtime import put
from restore_existing_business_volumes import load_volumes, restore


def main():
    p=argparse.ArgumentParser();p.add_argument('--installation',required=True);p.add_argument('--source',required=True)
    p.add_argument('--journal-directory',required=True);args=p.parse_args()
    if os.geteuid()!=0:raise PermissionError('root_required')
    record=load(args.installation);path=record['references']['storageVolumes']
    volumes=load_volumes(path)
    for volume in volumes:restore(volume,check_only=True)
    journal=Path(args.journal_directory);journal.mkdir(mode=0o700,parents=True,exist_ok=True)
    installed=Path('/usr/local/lib/teamaibox/restore_existing_business_volumes.py')
    put(installed,Path(args.source).read_bytes(),0o644,journal)
    unit=Path('/etc/systemd/system/teamaibox-existing-business-volumes.service.d/60-local-volumes.conf')
    put(unit,('[Service]\nExecStart=\nExecStart=/usr/bin/python3 '+str(installed)+' --configuration '+path+'\n').encode(),0o644,journal)
    # This exact product-owned file contributes a single ExecStartPre. Leave
    # all other Docker dependencies and guest pool checks unchanged.
    docker=Path('/etc/systemd/system/docker.service.d/teamaibox-existing-business-volumes.conf')
    content='[Unit]\nRequires=teamaibox-existing-business-volumes.service\nAfter=teamaibox-existing-business-volumes.service\n\n[Service]\nExecStartPre=/usr/bin/python3 '+str(installed)+' --configuration '+path+' --check\n'
    if volumes:put(docker,content.encode(),0o644,journal)
    else:raise ValueError('installed_restore_requires_explicit_volumes')
    # Preserve only explicitly imported legacy /tmp roots. New installations
    # have none; never ship a development machine's exclusion list.
    roots=sorted({v['root'] for v in volumes if v.get('root','').startswith('/tmp/')})
    tmpfiles='# Installation-specific legacy volume exclusions; no data is moved.\n'+''.join('x '+json.dumps(root,ensure_ascii=False)+' - - - -\n' for root in roots)
    put('/etc/tmpfiles.d/teamaibox-existing-business-volumes.conf',tmpfiles.encode(),0o644,journal)
    execute(['systemctl','daemon-reload'])
    print(json.dumps({'status':'installed','volumes':len(volumes),'dockerRestarted':False,'keysChanged':False,'mountsChanged':False}))


if __name__=='__main__':main()

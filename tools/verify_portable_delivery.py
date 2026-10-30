#!/usr/bin/env python3
"""Read-only deployment/protection comparison; no business requests or restarts."""
import argparse
import hashlib
import json
import ipaddress
from pathlib import Path
import appliance_installation as installation


def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def normalized(rows):
    result={}
    for row in rows:
        row={**row,'mounts':sorted(row['mounts'],key=lambda m:m['Destination'])}
        result[row['id']]=row
    return result


def main():
    p=argparse.ArgumentParser();p.add_argument('--before',required=True);p.add_argument('--source',required=True)
    p.add_argument('--journal',action='append',required=True);p.add_argument('--output',required=True)
    p.add_argument('--fixture-address',required=True,help='temporary IPv4 address used by this validation run')
    p.add_argument('--installation',default='/etc/teamaibox/installation.json');args=p.parse_args()
    fixture_address=str(ipaddress.IPv4Address(args.fixture_address))
    record=installation.load(args.installation);before=normalized(json.loads(Path(args.before).read_text()))
    current=normalized(installation.inventory());excluded=set();replacements=[]
    for path in args.journal:
        j=json.loads(Path(path).read_text())
        if j['installationId']!=record['installationId'] or j['status']!='complete':raise ValueError('unexpected_deployment_journal')
        actual=installation.resolve(record,j['role'])
        if actual['Id']!=j['newId']:raise ValueError('deployed_role_changed')
        excluded.update((j['previous']['containerId'],j['newId']))
        replacements.append({'role':j['role'],'containerId':j['newId'],'imageId':actual['Image'],'healthy':actual['State'].get('Health',{}).get('Status')=='healthy'})
    changed=[cid for cid,row in before.items() if cid not in excluded and current.get(cid)!=row]
    unexpected=[cid for cid in current if cid not in excluded and cid not in before]
    files={}
    names=('appliance_installation.py','appliance_delivery.py','appliance_namespace_upgrade.py','appliance_setup.py',
           'appliance_networks.py','appliance_https.py','appliance_network_identity.py','appliance_phone_media.py',
           'appliance_compatibility.py','host_drift.py','appliance_target.py','appliance_operations.py','appliance_database.py',
           'appliance_container_operations.py','prepare_portable_media.py','restore_appliance_frontdoor.py','restore_existing_business_volumes.py')
    for name in names:
        expected=digest(Path(args.source)/name);actual=digest(Path('/usr/local/lib/teamaibox')/name)
        if expected!=actual:raise ValueError('installed_helper_mismatch:'+name)
        files[name]=actual
    agent=installation.resolve(record,'node-agent')['Id'];api=installation.resolve(record,'platform-api')['Id']
    binaries={}
    for cid,inside,source in [(agent,'/usr/local/bin/teamaibox-node-agent','teamaibox-portable-node-agent'),
        (api,'/opt/teamaibox/services/scheduler/src/phone-media-network.mjs','phone-media-network.mjs'),
        (api,'/opt/teamaibox/services/scheduler/src/node-agent-https-transport.mjs','node-agent-https-transport.mjs')]:
        actual=installation.execute(['docker','exec',cid,'sha256sum',inside]).split()[0]
        if actual!=digest(Path(args.source)/source):raise ValueError('deployed_payload_mismatch:'+source)
        binaries[source]=actual
    network=json.loads(Path(record['references']['networkIdentity']).read_text())
    state=json.loads(Path(network['phoneMedia']['stateFile']).read_text())
    nat=installation.execute(['iptables','-t','nat','-S','TAIB-PHONE-NAT'])
    forward=installation.execute(['iptables','-S','TAIB-PHONE-FWD'])
    addresses=json.loads(installation.execute(['ip','-j','address','show']))
    addresses=[a['local'] for row in addresses for a in row.get('addr_info',[]) if a.get('family')=='inet']
    timer=installation.execute(['systemctl','show','-p','ActiveState','--value','teamaibox-network-identity.timer']).strip()
    fixture_ids=installation.execute(['docker','ps','-aq','--filter','label=com.teamaibox.fixture=namespace-upgrade']).split()
    guest_counts={}
    for row in before.values():
        kind=row['labels'].get('com.teamaibox.kind')
        if kind in ('android-phone','virtual-computer','windows-computer'):guest_counts[kind]=guest_counts.get(kind,0)+1
    cleanup=not state['runs'] and '--dport' not in nat and '--dport' not in forward and fixture_address not in addresses and not fixture_ids
    result={'status':'passed' if not changed and not unexpected and cleanup and timer=='active' and all(r['healthy'] for r in replacements) else 'failed',
        'installationId':record['installationId'],'nodeId':record['nodeId'],'protectedBefore':len(before),
        'protectedUnchanged':len(before)-len([cid for cid in before if cid in excluded])-len(changed),
        'changedProtectedIds':changed,'unexpectedRunningIds':unexpected,'originalGuestCounts':guest_counts,
        'replacements':replacements,'installedHelperSha256':files,'deployedPayloadSha256':binaries,
        'temporaryResourcesCleaned':cleanup,'addressTimer':timer,'phoneMediaStatus':state['status'],
        'remainingPhoneMediaRules':nat.count('--dport'),'scope':'identities, mounts, running state and start times; not a full disk-content hash'}
    Path(args.output).write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result))
    if result['status']!='passed':raise SystemExit(2)


if __name__=='__main__':main()

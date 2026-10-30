#!/usr/bin/env python3
"""Install host adapters and import their exact local references, without restart."""
import argparse
import hashlib
import json
import os
from pathlib import Path
from appliance_installation import load, save, execute
from appliance_network_identity import atomic_write


def put(path, raw, mode, journal):
    path = Path(path)
    if path.exists() and path.read_bytes() == raw: return
    if path.exists():
        digest = hashlib.sha256(str(path).encode()+path.read_bytes()).hexdigest()
        prior = journal / digest
        if not prior.exists(): atomic_write(prior, path.read_bytes(), 0o600)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(path, raw, mode)


def main():
    p = argparse.ArgumentParser(); p.add_argument('--source', required=True); p.add_argument('--installation', default='/etc/teamaibox/installation.json')
    p.add_argument('--frontdoor-configuration', required=True); p.add_argument('--library', default='/usr/local/lib/teamaibox')
    p.add_argument('--journal-directory', required=True)
    args = p.parse_args()
    if os.geteuid() != 0: raise PermissionError('root_required')
    record = load(args.installation); source = Path(args.source); library = Path(args.library)
    journal = Path(args.journal_directory); journal.mkdir(parents=True, exist_ok=True, mode=0o700)
    for name in ('appliance_installation.py','appliance_delivery.py','appliance_network_identity.py','appliance_phone_media.py','restore_appliance_frontdoor.py',
                 'appliance_setup.py','appliance_networks.py','appliance_compatibility.py','host_drift.py','appliance_target.py','appliance_https.py','prepare_portable_media.py',
                 'appliance_operations.py','appliance_database.py','appliance_container_operations.py','appliance_namespace_upgrade.py'):
        put(library/name, (source/name).read_bytes(), 0o644, journal)
    path = Path(args.frontdoor_configuration)
    config = json.loads(path.read_text()) if path.exists() else {'retired':[], 'ordered':[{'role':r} for r in ('postgres','platform-api','node-agent','appliance-gateway','maintenance-controller','web') if r in record['services']]}
    by_id = {s['containerId']:role for role,s in record['services'].items()}
    config['ordered'] = [{'role':by_id[row['id']]} if row.get('id') in by_id else row for row in config['ordered']]
    config['installationFile'] = str(Path(args.installation).resolve())
    put(path, (json.dumps(config, indent=2)+'\n').encode(), 0o600, journal)
    record['references']['frontdoor'] = str(path.resolve()); save(args.installation, record)
    dropin = Path('/etc/systemd/system/teamaibox-frontdoor.service.d/60-portable-installation.conf')
    base=Path('/etc/systemd/system/teamaibox-frontdoor.service')
    if not base.exists():
        put(base,b'[Unit]\nDescription=Restore installed Team AI Box services\nRequires=docker.service\nAfter=docker.service\nStartLimitIntervalSec=0\n[Service]\nType=oneshot\nRemainAfterExit=yes\nRestart=on-failure\nRestartSec=10\nTimeoutStartSec=600\n[Install]\nWantedBy=multi-user.target\n',0o644,journal)
    put(dropin, ('[Service]\nExecStart=\nExecStart=/usr/bin/python3 '+str(library/'restore_appliance_frontdoor.py')+' --configuration '+str(path)+'\n').encode(), 0o644, journal)
    execute(['systemctl','daemon-reload'])
    print(json.dumps({'status':'installed','servicesRestarted':False,'dataChanged':False}))


if __name__ == '__main__': main()

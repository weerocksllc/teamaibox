#!/usr/bin/env python3
"""Bind the existing casting bootstrap to a new local installation.

Called once during installation and by systemd before Docker at boot. This
does not advertise a receiver, start a user session, or restart Docker.
"""
import argparse
import datetime
import ipaddress
import json
import os
from pathlib import Path
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from offline_common import need, read_json, run, write_json


def declaration(record, *, command=run):
    network = record['networks']['plugin-ingress']
    actual = json.loads(command(['docker', 'network', 'inspect', network['id']]))[0]
    need(actual['Id'] == network['id'] and actual['Labels'].get('com.teamaibox.installation-id') == record['installationId'],
         'casting network does not belong to this installation')
    ipv4 = [c for c in actual['IPAM']['Config'] if ipaddress.ip_network(c['Subnet']).version == 4]
    need(len(ipv4) == 1, 'casting needs one local IPv4 control network')
    subnet = ipaddress.ip_network(ipv4[0]['Subnet'])
    need(subnet.num_addresses > 16, 'casting control subnet is too small')
    address = str(subnet.network_address + 10)
    need(not actual.get('Containers'), 'initial casting address allocation requires the new empty network')
    from appliance_network_identity import discover
    lan = next((a for a in discover() if ipaddress.ip_address(a).version == 4), None)
    need(lan, 'connect this box to an IPv4 LAN before first installation')
    interfaces = json.loads(command(['ip', '-j', 'address', 'show']))
    interface = next(r['ifname'] for r in interfaces if any(a.get('local') == lan for a in r.get('addr_info', [])))
    return dict(schemaVersion=1, installationId=record['installationId'], nodeId=record['nodeId'],
        nodeGroupId=str(uuid.uuid5(uuid.UUID(record['installationId']), 'casting-group')),
        bridgeAddress=ipv4[0]['Gateway'], platformAddress=address, initialLanAddress=lan, initialInterface=interface,
        protectedSetId='factory-office-' + record['installationId'],
        generation='casting-service-' + datetime.date.today().strftime('%Y%m%d') + '-a1')


def boot(root, configuration, *, check=False):
    from bootstrap_casting_service import bootstrap, certificates_valid
    from casting_service_credentials import DESTINATION, FILES, require_tmpfs
    destination = DESTINATION / configuration['generation']
    if not check:
        # /run is cleared at boot; create directories, never an on-disk
        # credential cache, and refuse linked/reowned parents.
        for path in (DESTINATION.parent, DESTINATION):
            need(not path.is_symlink(), 'casting runtime parent must not be a symlink')
            path.mkdir(exist_ok=True, mode=0o755)
            need(path.stat().st_uid == 0 and path.stat().st_mode & 0o022 == 0,
                 'casting runtime parent is not root-owned')
    marker = DESTINATION / ('factory-' + configuration['installationId'] + '.json')
    boot_id = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    expected = dict(installationId=configuration['installationId'], bootId=boot_id, configuration=configuration)
    if marker.exists():
        need(read_json(marker) == expected, 'casting bootstrap ownership differs')
        require_tmpfs(destination)
        certificates_valid(destination)
        for section, (uid, names) in FILES.items():
            for name in names:
                path = destination / section / name
                need(not path.is_symlink() and path.is_file() and path.stat().st_uid == uid
                     and path.stat().st_mode & 0o777 == 0o400, 'casting bootstrap file missing or modified')
    else:
        need(not check, 'casting boot identity not prepared')
        from appliance_network_identity import discover
        addresses = discover()
        address = next((a for a in addresses if ipaddress.ip_address(a).version == 4), None)
        # Credential preparation must not prevent Docker/office boot merely
        # because DHCP is still pending. The existing identity timer updates
        # the advertised address/interface as soon as the LAN is available.
        interface = configuration['initialInterface']
        if address:
            interfaces = json.loads(run(['ip', '-j', 'address', 'show']))
            interface = next(r['ifname'] for r in interfaces if any(a.get('local') == address for a in r.get('addr_info', [])))
        else:
            address = configuration['initialLanAddress']
        plan = {k: configuration[k] for k in ('schemaVersion', 'generation', 'nodeId', 'nodeGroupId',
                                             'bridgeAddress', 'platformAddress', 'protectedSetId')}
        plan.update(nodeGeneration=1, lanAddress=address, interface=interface)
        contract = read_json(root / 'runtime/deploy/casting/trusted-media-callback-contract.v1.json')
        bootstrap(plan, contract)
        write_json(marker, expected)
    return dict(root=str(destination), environment=read_json(destination / 'platform/platform.env.json'),
                bridgeAddress=configuration['bridgeAddress'], platformAddress=configuration['platformAddress'])


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--installation-root', type=Path, required=True)
    p.add_argument('--check', action='store_true')
    args = p.parse_args()
    need(os.geteuid() == 0, 'root required')
    root = args.installation_root.resolve()
    boot(root, read_json(root / 'config/casting-installation.json'), check=args.check)
    print(json.dumps(dict(status='ready', receiverStarted=False, dockerRestarted=False)))

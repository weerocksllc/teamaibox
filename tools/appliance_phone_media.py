#!/usr/bin/env python3
"""Exact LAN forwarding for owned phone runs. No guest or global route changes."""
import ipaddress
import json
import re
import subprocess
import time
from pathlib import Path

NAT = 'TAIB-PHONE-NAT'
FILTER = 'TAIB-PHONE-FWD'
MARK = 'teamaibox-phone-media-v1'


def command(args, *, data=None, allowed=(0,)):
    result = subprocess.run(args, input=data, capture_output=True, text=True, timeout=30)
    if result.returncode not in allowed:
        raise RuntimeError('phone_media_command_failed:' + args[0])
    return result.stdout


def private_ipv4(value):
    ip = ipaddress.ip_address(value)
    if ip.version != 4 or not any(ip in ipaddress.ip_network(n) for n in ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')):
        raise ValueError('phone_media_private_ipv4_required')
    return str(ip)


def inspect_runs(config, containers):
    result = {}
    ports = set()
    for c in containers:
        labels = c['Config'].get('Labels') or {}
        if labels.get('com.teamaibox.node-id') != config['nodeId'] or labels.get('com.teamaibox.pool-id') != config['poolId']:
            continue
        if labels.get('com.teamaibox.managed') != 'true' or labels.get('com.teamaibox.kind') != 'android-phone' or not c['State']['Running']:
            continue
        run = labels['com.teamaibox.phone-run-id']
        if not re.fullmatch(r'[a-f0-9-]{36}', run) or c['Name'] != '/teamaibox-phone-' + run:
            raise ValueError('phone_media_run_identity_invalid')
        path = Path(config['controlRoot']) / run / 'config.json'
        if path.is_symlink() or path.parent.is_symlink():
            raise ValueError('phone_media_run_symlink')
        declaration = json.loads(path.read_text())
        for field, label in [('runId', 'phone-run-id'), ('phoneId', 'phone-id'), ('ownerId', 'owner-identity-id'), ('volumeId', 'volume-id')]:
            if declaration[field] != labels['com.teamaibox.' + label]:
                raise ValueError('phone_media_run_binding_mismatch')
        if str(declaration['generation']) != labels['com.teamaibox.phone-generation']:
            raise ValueError('phone_media_generation_mismatch')
        first = 20000 + (declaration['instance'] - 21) * 100
        if type(first) is not int or first < 20000 or first + 49 > 65535 or first in ports:
            raise ValueError('phone_media_port_collision_or_range')
        ports.add(first)
        network_id = c['HostConfig']['NetworkMode']
        networks = c['NetworkSettings']['Networks'].values()
        primary = [n for n in networks if n['NetworkID'] == network_id and n['NetworkID'] != config['controlNetworkId']]
        if len(primary) != 1:
            raise ValueError('phone_media_network_identity_invalid')
        result[run] = dict(containerId=c['Id'], startedAt=c['State']['StartedAt'],
                           containerAddress=private_ipv4(primary[0]['IPAddress']), firstPort=first, lastPort=first+49)
    return result


def rules(runs, address, interface):
    if address:
        private_ipv4(address)
        if not re.fullmatch(r'[A-Za-z0-9_.:-]+', interface):
            raise ValueError('phone_media_interface_invalid')
    nat, forward = [], []
    for run in runs.values() if address else []:
        target = private_ipv4(run['containerAddress'])
        first, last = run['firstPort'], run['lastPort']
        if type(first) is not int or type(last) is not int or first < 20000 or (first-20000)%100 or last != first+49 or last > 65535:
            raise ValueError('phone_media_port_range_invalid')
        ports = str(run['firstPort']) + ':' + str(run['lastPort'])
        for protocol in ('tcp', 'udp'):
            nat.append(f'-A {NAT} -i {interface} -d {address}/32 -p {protocol} --dport {ports} -j DNAT --to-destination {target}')
            forward.append(f'-A {FILTER} -i {interface} -d {target}/32 -p {protocol} --dport {ports} -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT')
            forward.append(f'-A {FILTER} -o {interface} -s {target}/32 -p {protocol} --sport {ports} -m conntrack --ctstate ESTABLISHED -j ACCEPT')
    return nat, forward


def apply_rules(nat, forward):
    # Use the same iptables frontend Docker uses (nf_tables or legacy), not a
    # parallel native nft ruleset. Never flush Docker/user chains or policies.
    command(['iptables', '-w', '5', '-t', 'nat', '-S', 'DOCKER'])
    command(['iptables', '-w', '5', '-S', 'DOCKER-USER'])
    for table, chain, parent, entries in [('filter', FILTER, 'DOCKER-USER', forward), ('nat', NAT, 'PREROUTING', nat)]:
        listing = command(['iptables', '-w', '5', '-t', table, '-S'])
        hook = f'-A {parent} -m comment --comment {MARK} -j {chain}'
        quoted_hook = f'-A {parent} -m comment --comment "{MARK}" -j {chain}'
        exists = f'-N {chain}\n' in listing
        attached = hook in listing.splitlines() or quoted_hook in listing.splitlines()
        if exists and not attached:
            raise RuntimeError('phone_media_chain_not_owned')
        desired = [f'-A {chain} -m comment --comment {MARK} -j RETURN']
        current = [line.replace('"', '') for line in listing.splitlines() if line.startswith(f'-A {chain} ')]
        if current == entries + desired and attached:
            continue
        # Each table is committed transactionally; publish readiness only when
        # both succeeded. An interrupted first install leaves no false ready.
        body = [f'*{table}', f':{chain} - [0:0]', f'-F {chain}', *entries, *desired]
        if not attached:
            body.append(f'-I {parent} 1 -m comment --comment {MARK} -j {chain}')
        body += ['COMMIT', '']
        command(['iptables-restore', '--wait', '5', '--noflush'], data='\n'.join(body))


def reconcile(config, addresses, rows, write):
    state = dict(version=1, nodeId=config['nodeId'], poolId=config['poolId'],
                 status='preparing', updatedAt=int(time.time()), runs={})
    # Revoke a previously ready state before attempting a changed mapping.
    address = next((a for a in addresses if ipaddress.ip_address(a).version == 4), None)
    if address:
        address = private_ipv4(address)
    path = config['stateFile']
    try:
        ids = command(['docker', 'ps', '-q', '--no-trunc', '--filter', 'label=com.teamaibox.kind=android-phone',
                       '--filter', 'label=com.teamaibox.node-id=' + config['nodeId']]).split()
        containers = json.loads(command(['docker', 'inspect', *ids])) if ids else []
        runs = inspect_runs(config, containers)
        interface = next((r['ifname'] for r in rows if any(a.get('local') == address for a in r.get('addr_info', []))), '') if address else ''
        nat, forward = rules(runs, address, interface)
        apply_rules(nat, forward)
        state['status'] = 'ready' if address else 'waiting_for_network'
        state['runs'] = {k: {**v, 'address': address} for k, v in runs.items()} if address else {}
    finally:
        write(path, (json.dumps(state, sort_keys=True) + '\n').encode())
    return state['status']

"""Reconcile only interface roles in an already owned phone namespace.

Executed by the installed Node Agent, not exposed as a user exec operation.
The complete existing rules must match the installed phone recipe; Docker's
loopback DNS rules are retained. No host interfaces, routes or rules are used.
"""
import importlib.util
import ipaddress
import json
import re
import shlex
import subprocess
import sys


def command(args, data=None):
    result = subprocess.run(args, input=data, capture_output=True, timeout=10)
    if result.returncode:
        raise RuntimeError('phone_network_role_command_failed')
    return result.stdout


def swap_interfaces(raw):
    return '\n'.join(' '.join('eth1' if word == 'eth0' else 'eth0' if word == 'eth1' else word
                              for word in line.split(' ')) for line in raw.splitlines()) + '\n'


def normalized(raw, module):
    """Ignore counters and iptables' formatting, not rule order or semantics."""
    tables, table, dns = {}, None, []
    for line in raw.splitlines():
        if not line or line.startswith('#'):
            continue
        if line.startswith('*'):
            table = line[1:]
            if table not in ('filter', 'nat') or table in tables:
                raise RuntimeError('phone_network_rules_foreign')
            tables[table] = {'chains': {}, 'rules': {}}
        elif line == 'COMMIT':
            table = None
        elif table is None:
            raise RuntimeError('phone_network_rules_foreign')
        elif line.startswith(':'):
            match = re.fullmatch(r':(\w+) (ACCEPT|DROP|-) \[\d+:\d+\]', line)
            if not match:
                raise RuntimeError('phone_network_rules_foreign')
            name, policy = match.groups()
            if table == 'nat' and name.startswith('DOCKER_'):
                dns.append(line)
            else:
                tables[table]['chains'][name] = policy
        elif line.startswith('-A '):
            words = shlex.split(line)
            if table == 'nat' and any(word in ('DOCKER_OUTPUT', 'DOCKER_POSTROUTING') for word in words):
                dns.append(line)
                continue
            chain = words[1]
            pairs, index = [], 2
            while index < len(words):
                if index + 1 >= len(words) or not words[index].startswith('-'):
                    raise RuntimeError('phone_network_rules_foreign')
                key, value = words[index:index+2]
                index += 2
                if key == '-m' and value in ('tcp', 'udp') or key == '--reject-with' and value == 'icmp-port-unreachable':
                    continue
                if key == '--ctstate':
                    value = ','.join(sorted(value.split(',')))
                pairs.append((key, value))
            tables[table]['rules'].setdefault(chain, []).append(sorted(pairs))
        else:
            raise RuntimeError('phone_network_rules_foreign')
    if table is not None:
        raise RuntimeError('phone_network_rules_foreign')
    if dns:
        dns_raw = '*nat\n' + '\n'.join(dns) + '\nCOMMIT\n'
        if not module.fresh_rules(dns_raw):
            raise RuntimeError('phone_network_dns_foreign')
    return tables


def reconcile(instance, primary, control, module, run=command, allow_change=True):
    module.recipe(instance)  # Installed, disjoint instance/port range.
    for value in (primary, control):
        address = ipaddress.ip_address(value)
        if address.version != 4 or not address.is_private or address.is_loopback or address.is_unspecified:
            raise RuntimeError('phone_network_address_invalid')
    if primary == control:
        raise RuntimeError('phone_network_address_invalid')
    links = json.loads(run(['/usr/sbin/ip', '-j', '-4', 'address', 'show']))
    by_address = {info['local']: link['ifname'] for link in links
                  for info in link.get('addr_info', []) if info.get('family') == 'inet'}
    primary_interface, control_interface = by_address.get(primary), by_address.get(control)
    if {primary_interface, control_interface} != {'eth0', 'eth1'}:
        raise RuntimeError('phone_network_role_identity_mismatch')
    routes = json.loads(run(['/usr/sbin/ip', '-j', '-4', 'route', 'show', 'default']))
    if len(routes) != 1 or routes[0].get('dev') != primary_interface or not routes[0].get('gateway'):
        raise RuntimeError('phone_network_primary_ambiguous')
    original = run(['/usr/sbin/iptables-save']).decode()
    base, _ = module.rules(instance, True)
    reverse = swap_interfaces(base)
    observed = normalized(original, module)
    expected = base if primary_interface == 'eth0' else reverse
    if observed == normalized(expected, module):
        return {'changed': False, 'primaryInterface': primary_interface, 'controlInterface': control_interface}
    other = reverse if primary_interface == 'eth0' else base
    if observed != normalized(other, module):
        raise RuntimeError('phone_network_rules_foreign')
    if not allow_change:
        raise RuntimeError('phone_network_role_not_reconciled')
    replacement = swap_interfaces(original)
    run(['/usr/sbin/iptables-restore', '--wait', '3', '--test'], replacement.encode())
    try:
        run(['/usr/sbin/iptables-restore', '--wait', '3'], replacement.encode())
        if normalized(run(['/usr/sbin/iptables-save']).decode(), module) != normalized(expected, module):
            raise RuntimeError('phone_network_role_readback_failed')
    except Exception:
        run(['/usr/sbin/iptables-restore', '--wait', '3'], original.encode())
        raise
    return {'changed': True, 'primaryInterface': primary_interface, 'controlInterface': control_interface}


if __name__ == '__main__':
    spec = importlib.util.spec_from_file_location('installed_phone_network', '/opt/teamaibox/phone_network.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    print(json.dumps(reconcile(int(sys.argv[1]), sys.argv[2], sys.argv[3], module,
                               allow_change='--check' not in sys.argv[4:])))

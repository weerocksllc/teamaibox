"""Phone-private network setup, before Android starts; never run on the host.

The installed Docker recipe must provide a fresh per-phone network namespace.
Only its short init stage needs NET_ADMIN/TUN. Android and Cuttlefish run after
all setup capabilities have been dropped. No daemon, host route or host firewall
configuration is installed by this module.
"""
import ipaddress
import json
import os
import re
import subprocess

# Deny on destination packets, not just DNS answers. This also covers a name
# changing from a public answer to a private address between connections.
DENIED_V4 = ('0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
             '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
             '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24',
             '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4')
GUEST_NETWORK = '192.168.246.0/30'
GUEST_ADDRESS = '192.168.246.2'
GATEWAY = '192.168.246.1/30'


def recipe(instance):
    # The end of this instance's disjoint media range must fit a TCP/UDP port.
    if type(instance) is not int or not 21 <= instance <= 21+(65535-20049)//100:
        raise ValueError('phone_network_instance_invalid')
    return {'mobile': f'cvd-mtap-{instance}', 'ethernet': f'cvd-etap-{instance}',
            'wifi': f'cvd-wtap-{instance}', 'signalPort': 8443 + instance - 1,
            'mediaFirst': 20000 + (instance - 21) * 100,
            'mediaLast': 20049 + (instance - 21) * 100}


def public_guest_destination(value):
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return address.version == 4 and not any(address in ipaddress.ip_network(n) for n in DENIED_V4)


def rules(instance, control=False, primary_interface='eth0'):
    if primary_interface not in ('eth0', 'eth1') or not control and primary_interface != 'eth0':
        raise ValueError('phone_network_interface_invalid')
    r = recipe(instance)
    tap = r['mobile']
    media = f"{r['mediaFirst']}:{r['mediaLast']}"
    v4 = ['*filter', ':INPUT DROP [0:0]', ':FORWARD DROP [0:0]', ':OUTPUT DROP [0:0]',
          ':PHONE_PUBLIC - [0:0]', '-A INPUT -i lo -j ACCEPT',
          # A guest may not reach the runtime's operator, ADB or other sockets.
          f'-A INPUT -i {tap} -j REJECT',
          '-A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
          f"-A INPUT -i eth0 -p tcp --dport {r['signalPort']} -j ACCEPT",
          f'-A INPUT -i eth0 -p udp --dport {media} -j ACCEPT',
          f'-A INPUT -i eth0 -p tcp --dport {media} -j ACCEPT',
          '-A OUTPUT -o lo -j ACCEPT',
          '-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
          # WebRTC replies/checks originate in the trusted streamer, not the
          # guest forwarding chain. Only this fixed source-port range may
          # address LAN browsers. Raw operator/ADB ports are never published.
          f'-A OUTPUT -o eth0 -p udp --sport {media} -j ACCEPT',
          f'-A OUTPUT -o eth0 -p tcp --sport {media} -j ACCEPT',
          '-A OUTPUT -o eth0 -j PHONE_PUBLIC',
          f'-A FORWARD -i eth0 -o {tap} -d {GUEST_ADDRESS}/32 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
          f'-A FORWARD -i {tap} -o eth0 -s {GUEST_ADDRESS}/32 -j PHONE_PUBLIC']
    if control:
        # The installation-owned second interface is shared only with Node
        # Agent. It carries signalling, while media and guest egress stay on
        # the per-phone primary interface.
        v4.insert(v4.index('-A OUTPUT -o lo -j ACCEPT'),
                  f"-A INPUT -i eth1 -p tcp --dport {r['signalPort']} -j ACCEPT")
    v4 += [f'-A PHONE_PUBLIC -d {network} -j REJECT' for network in DENIED_V4]
    v4 += ['-A PHONE_PUBLIC -p tcp -j ACCEPT', '-A PHONE_PUBLIC -p udp -j ACCEPT',
           '-A PHONE_PUBLIC -p icmp -j ACCEPT', '-A PHONE_PUBLIC -j REJECT', 'COMMIT',
           '*nat', ':PREROUTING ACCEPT [0:0]', ':INPUT ACCEPT [0:0]',
           ':OUTPUT ACCEPT [0:0]', ':POSTROUTING ACCEPT [0:0]',
           f'-A POSTROUTING -s {GUEST_ADDRESS}/32 -o eth0 -j MASQUERADE', 'COMMIT']
    # First release has IPv4 app egress only. No IPv6 path may bypass the
    # private/metadata filters, including ULA, link-local or IPv4-mapped forms.
    v6 = ['*filter', ':INPUT DROP [0:0]', ':FORWARD DROP [0:0]', ':OUTPUT DROP [0:0]',
          '-A INPUT -i lo -j ACCEPT', '-A OUTPUT -o lo -j ACCEPT', 'COMMIT']
    if primary_interface == 'eth1':
        # Swap whole interface tokens, never arbitrary substrings. Signalling
        # remains allowed on both, media/egress only on the primary network.
        v4 = [' '.join('eth1' if token == 'eth0' else 'eth0' if token == 'eth1' else token
                       for token in line.split(' ')) for line in v4]
    return '\n'.join(v4) + '\n', '\n'.join(v6) + '\n'


def primary_interface(control, run=None):
    run = command if run is None else run
    if not control:
        return 'eth0'
    # The installation-owned control bridge has no gateway. Docker is free to
    # attach it first after recreation, so interface names are not stable roles.
    routes = json.loads(run(['/usr/sbin/ip', '-j', '-4', 'route', 'show', 'default']))
    if len(routes) != 1 or routes[0].get('dev') not in ('eth0', 'eth1') or not routes[0].get('gateway'):
        raise RuntimeError('phone_network_primary_ambiguous')
    return routes[0]['dev']


def command(args, data=None):
    p = subprocess.run(args, input=data, capture_output=True, timeout=10)
    if p.returncode:
        raise RuntimeError('phone_network_setup_failed:' + args[0].rsplit('/', 1)[-1])
    return p.stdout


def fresh_rules(raw):
    """Allow only empty built-ins and Docker's exact loopback DNS NAT recipe."""
    table = None
    dns = []
    definitions = set()
    for line in raw.splitlines():
        if not line or line.startswith('#'): continue
        if line.startswith('*'):
            if table is not None or line[1:] not in ('filter','nat','mangle','raw','security'): return False
            table = line[1:]
        elif line == 'COMMIT':
            if table is None: return False
            table = None
        elif line.startswith(':'):
            if table is None: return False
            if re.fullmatch(r':(PREROUTING|INPUT|FORWARD|OUTPUT|POSTROUTING) ACCEPT \[\d+:\d+\]',line): continue
            if table=='nat' and re.fullmatch(r':DOCKER_(OUTPUT|POSTROUTING) - \[\d+:\d+\]',line):
                definitions.add(line.split()[0][1:]);continue
            return False
        elif line.startswith('-A ') and table=='nat': dns.append(line)
        else: return False
    if table is not None: return False
    if not dns: return not definitions
    if len(dns)!=6 or definitions!={'DOCKER_OUTPUT','DOCKER_POSTROUTING'}: return False
    expected={'-A OUTPUT -d 127.0.0.11/32 -j DOCKER_OUTPUT',
              '-A POSTROUTING -d 127.0.0.11/32 -j DOCKER_POSTROUTING'}
    for protocol in ('tcp','udp'):
        matches=[re.fullmatch(r'-A DOCKER_OUTPUT -d 127\.0\.0\.11/32 -p '+protocol+
                r' -m '+protocol+r' --dport 53 -j DNAT --to-destination 127\.0\.0\.11:(\d+)',line) for line in dns]
        ports=[int(match[1]) for match in matches if match]
        if len(ports)!=1 or not 1024<=ports[0]<=65535:return False
        expected.add(f'-A DOCKER_OUTPUT -d 127.0.0.11/32 -p {protocol} -m {protocol} --dport 53 -j DNAT --to-destination 127.0.0.11:{ports[0]}')
        expected.add(f'-A DOCKER_POSTROUTING -s 127.0.0.11/32 -p {protocol} -m {protocol} --sport {ports[0]} -j SNAT --to-source :53')
    return set(dns)==expected


def initialize(instance, run=command):
    r = recipe(instance)
    control = os.environ.get('TEAMAIBOX_PHONE_CONTROL_NETWORK') == '1'
    links = json.loads(run(['/usr/sbin/ip', '-j', 'link', 'show']))
    if {link['ifname'] for link in links} != ({'lo', 'eth0', 'eth1'} if control else {'lo', 'eth0'}):
        raise RuntimeError('phone_network_namespace_not_fresh')
    # Refuse an existing firewall rather than flushing or overwriting it.
    for binary in ('iptables-save', 'ip6tables-save'):
        existing = run(['/usr/sbin/' + binary]).decode()
        if not fresh_rules(existing):
            raise RuntimeError('phone_network_namespace_not_fresh')
    v4, v6 = rules(instance, control, primary_interface(control, run))
    # No tap exists until BOTH filters have succeeded. If setup fails later,
    # Android is not launched and the container namespace is disposable.
    run(['/usr/sbin/ip6tables-restore', '--wait', '3', '--noflush'], v6.encode())
    run(['/usr/sbin/iptables-restore', '--wait', '3', '--noflush'], v4.encode())
    for name in (r['mobile'], r['ethernet'], r['wifi']):
        run(['/usr/sbin/ip', 'tuntap', 'add', 'dev', name, 'mode', 'tap', 'user', '10001', 'group', '10001'])
        if name == r['mobile']:
            run(['/usr/sbin/ip', 'address', 'add', GATEWAY, 'broadcast', '+', 'dev', name])
        run(['/usr/sbin/ip', 'link', 'set', 'dev', name, 'up'])
    return r

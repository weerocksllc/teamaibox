#!/usr/bin/env python3
"""Maintain the HTTPS identity of this host, without recreating any service.

Run from the host systemd timer, never from a container. Configuration is
root-owned and contains paths/container name, not a public IP address.
"""
import argparse
import fcntl
import ipaddress
import json
import os
import re
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time


def run(args):
    return subprocess.check_output(args, stderr=subprocess.PIPE, timeout=20)


def lan_addresses(rows, physical):
    result = set()
    for interface in rows:
        if interface['ifname'] not in physical or 'UP' not in interface.get('flags', []):
            continue
        for item in interface.get('addr_info', []):
            if item.get('scope') != 'global' or item.get('tentative') or item.get('dadfailed'):
                continue
            address = ipaddress.ip_address(item['local'])
            if not (address.is_loopback or address.is_link_local or address.is_multicast or address.is_unspecified):
                result.add(str(address))
    return sorted(result)


def discover():
    # Exclude Docker, TUN/VPN, loopback and guest-only interfaces. Ethernet,
    # Wi-Fi and physical NIC bonds are accepted without pinning an interface.
    root = Path('/sys/class/net')
    physical = {p.name for p in root.iterdir() if (p / 'device').exists()}
    physical |= {p.name for p in root.iterdir()
                 if (p / 'bonding/slaves').exists()
                 and set((p / 'bonding/slaves').read_text().split()) & physical}
    rows = json.loads(run(['ip', '-j', 'address', 'show']))
    addresses = lan_addresses(rows, physical)
    routes = json.loads(run(['ip', '-j', 'route', 'show', 'default']))
    preferred = next((r for r in sorted(routes, key=lambda r:r.get('metric', 0)) if r.get('dev') in physical), None)
    if preferred:
        primary = lan_addresses([r for r in rows if r['ifname'] == preferred['dev']], physical)
        if preferred.get('prefsrc') in primary:
            primary.remove(preferred['prefsrc'])
            primary.insert(0, preferred['prefsrc'])
        addresses = primary + [a for a in addresses if a not in primary]
    return addresses


def sfu_configuration(text, address, interface):
    if not re.fullmatch(r'[A-Za-z0-9_.:-]+', interface):
        raise ValueError('Invalid LAN interface')
    # Modify the two address-dependent fields only, retaining secrets/ports.
    text, count = re.subn(r'(?m)^  node_ip:.*$', '  node_ip: ' + address, text)
    if count != 1:
        raise ValueError('Expected one RTC node_ip field')
    text, count = re.subn(r'(?m)^    includes:.*$', '    includes: [' + interface + ']', text)
    if count != 1:
        raise ValueError('Expected one RTC interface filter')
    return text


def atomic_write(path, data, mode=0o644):
    path = Path(path)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(temporary, mode)
        if path.exists():
            info = path.stat()
            os.chown(temporary, info.st_uid, info.st_gid)
            os.chmod(temporary, info.st_mode & 0o777)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def reconcile(config):
    if config.get('installationFile'):
        from appliance_installation import load, resolve
        installation = load(config['installationFile'])
        config = {**config, 'webContainer': resolve(installation, 'web')['Id']}
        if 'sfu' in installation['services']:
            config['sfuContainer'] = resolve(installation, 'sfu')['Id']
    directory = Path(config['tlsDirectory'])
    cert = directory / 'web.crt'
    addresses = discover()
    phone_status = None
    if config.get('phoneMedia'):
        from appliance_phone_media import reconcile as reconcile_phone_media
        try:
            phone_status = reconcile_phone_media(config['phoneMedia'], addresses,
                                  json.loads(run(['ip', '-j', 'address', 'show'])), atomic_write)
        except Exception as error:
            # A phone mapping failure must not prevent HTTPS address recovery.
            # The media adapter revokes readiness; the next timer retries it.
            phone_status = 'preparing:' + type(error).__name__
    # A transient link outage is not grounds to invalidate the last certificate.
    if not addresses:
        if config.get('publicStateFile'):
            atomic_write(config['publicStateFile'], b'{"addresses": [], "dnsNames": []}\n')
        return {'status': 'waiting_for_network', 'changed': False, 'phoneMedia': phone_status}
    names = sorted(set(config.get('dnsNames', []) + [socket.gethostname().split('.')[0] + '.local']))
    if any(not name.endswith('.local') or not all(c.isalnum() or c in '.-' for c in name) for name in names):
        raise ValueError('Only local DNS names are allowed')
    desired = {'addresses': addresses, 'dnsNames': names}
    state_file = directory / 'appliance-addresses.json'
    old = json.loads(state_file.read_text()) if state_file.exists() else {}
    try:
        run(['openssl', 'x509', '-in', str(cert), '-noout', '-checkend', str(30 * 86400)])
        expires_soon = False
    except subprocess.CalledProcessError:
        expires_soon = True
    changed = any(old.get(k) != v for k, v in desired.items()) or expires_soon
    # Readers consume this public file on demand; no API restart on DHCP.
    if config.get('publicStateFile'):
        atomic_write(config['publicStateFile'], (json.dumps(desired) + '\n').encode())
    if changed:
        with tempfile.TemporaryDirectory(prefix='.identity-', dir=directory) as stage:
            stage = Path(stage)
            extension = stage / 'extensions.cnf'
            extension.write_text('basicConstraints=critical,CA:FALSE\n'
                                 'keyUsage=critical,digitalSignature,keyEncipherment\n'
                                 'extendedKeyUsage=serverAuth\nsubjectAltName=' +
                                 ','.join(['DNS:' + n for n in names] + ['IP:' + a for a in addresses]) + '\n')
            run(['openssl', 'req', '-new', '-key', str(directory / 'web.key'),
                 '-subj', '/CN=' + names[0], '-out', str(stage / 'web.csr')])
            run(['openssl', 'x509', '-req', '-in', str(stage / 'web.csr'),
                 '-CA', str(directory / 'ca.crt'), '-CAkey', str(directory / 'ca.key'),
                 '-set_serial', '0x' + secrets.token_hex(16), '-days', '365', '-sha256',
                 '-extfile', str(extension), '-out', str(stage / 'web.crt')])
            run(['openssl', 'verify', '-CAfile', str(directory / 'ca.crt'), str(stage / 'web.crt')])
            atomic_write(cert, (stage / 'web.crt').read_bytes() + (directory / 'ca.crt').read_bytes())
    # Track the exact PID/container and certificate: a failed reload or a web
    # replacement is retried, but a healthy service is not signalled each tick.
    container = json.loads(run(['docker', 'inspect', config['webContainer']]))[0]
    if not container['State']['Running']:
        return {'status': 'waiting_for_web', 'changed': changed}
    fingerprint = run(['openssl', 'x509', '-in', str(cert), '-noout', '-fingerprint', '-sha256']).decode().strip().split('=', 1)[1]
    generation = [container['Id'], container['State']['StartedAt'], fingerprint]
    if changed or old.get('webGeneration') != generation:
        run(['docker', 'kill', '--signal=HUP', container['Id']])
        # Health reports the currently loaded certificate, not just the file.
        expected = fingerprint
        for _ in range(20):
            try:
                loaded = json.loads(run(['docker', 'exec', container['Id'], 'node', '-e',
                    "require('https').get('https://127.0.0.1:'+process.env.WEB_PORT+'/health/ready',"
                    "{rejectUnauthorized:false},r=>{r.pipe(process.stdout)}).on('error',()=>process.exit(1))"]))
                if loaded.get('certificateFingerprint256') == expected:
                    break
            except (subprocess.CalledProcessError, json.JSONDecodeError):
                pass
            time.sleep(0.25)
        else:
            raise RuntimeError('Web did not confirm certificate reload; next timer run retries')
    sfu_generation = old.get('sfuGeneration')
    if config.get('sfuConfig') and config.get('sfuContainer'):
        address = next((a for a in addresses if ipaddress.ip_address(a).version == 4), None)
        if address:
            rows = json.loads(run(['ip', '-j', 'address', 'show']))
            interface = next(r['ifname'] for r in rows if any(a.get('local') == address for a in r.get('addr_info', [])))
            path = Path(config['sfuConfig'])
            previous = path.read_text()
            updated = sfu_configuration(previous, address, interface)
            sfu_generation = [address, interface]
            if previous != updated or old.get('sfuGeneration') != sfu_generation:
                atomic_write(path, updated.encode(), 0o600)
                # LiveKit's advertised ICE address is fixed at process startup.
                # Only this network-facing relay restarts, never Docker/guests.
                run(['docker', 'restart', '--time=5', config['sfuContainer']])
    atomic_write(state_file, (json.dumps({**desired, 'webGeneration': generation,
                                        'sfuGeneration': sfu_generation}, indent=2) + '\n').encode())
    return {'status': 'ready', 'changed': changed, 'phoneMedia': phone_status, **desired}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--configuration', required=True)
    args = parser.parse_args()
    path = Path(args.configuration)
    if os.geteuid() != 0 or path.stat().st_uid != 0 or path.stat().st_mode & 0o022:
        raise PermissionError('Root-owned non-writable configuration required')
    with open('/run/lock/teamaibox-network-identity.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        print(json.dumps(reconcile(json.loads(path.read_text()))), flush=True)


if __name__ == '__main__':
    main()

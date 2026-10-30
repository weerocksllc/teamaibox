#!/usr/bin/env python3
"""Connection-only checks between two exact running phones; no guest writes."""
import argparse
import datetime
import json
import re
import subprocess


def command(args):
    result = subprocess.run(args, capture_output=True, timeout=12)
    if result.returncode:
        raise RuntimeError('inspection_failed:' + args[0])
    return result.stdout.decode()


def inspect(name, expected_id):
    if not re.fullmatch(r'teamaibox-phone-[a-f0-9-]{36}', name):
        raise ValueError('invalid_phone_target')
    item = json.loads(command(['docker', 'inspect', name]))[0]
    if item['Id'] != expected_id or not item['State']['Running']:
        raise ValueError('phone_identity_changed')
    return item


def counters(pid):
    raw = command(['nsenter', '-t', str(pid), '-n', 'iptables-save', '-c'])
    return {m[2]: int(m[1]) for line in raw.splitlines()
            if (m := re.match(r'\[(\d+):\d+\] (-A PHONE_PUBLIC .* -j REJECT.*)', line))}


def rejection_deltas(before, after, cidr):
    return {rule: packets - before.get(rule, 0) for rule, packets in after.items()
            if f'-d {cidr} ' in rule and packets > before.get(rule, 0)}


def identity(item):
    return { 'name': item['Name'].lstrip('/'), 'id': item['Id'],
             'image': item['Image'], 'startedAt': item['State']['StartedAt'] }


def phone(item):
    name = item['Name'].lstrip('/')
    cfg = json.loads(command(['docker', 'exec', '--user', '10001:10001', name,
        'python3', '-c', 'import json; v=json.load(open("/run/phone/config.json")); print(json.dumps({k:v[k] for k in ("phoneId","instance")}))']))
    number = cfg['instance']
    if not isinstance(number, int) or not 21 <= number <= 475:
        raise ValueError('invalid_phone_instance')
    networks = item['NetworkSettings']['Networks']
    primary = networks[name]['IPAddress']
    if not primary.startswith('192.168.'):
        raise ValueError('unexpected_primary_network')
    control = [v['IPAddress'] for k, v in networks.items() if k != name]
    if len(control) != 1 or not control[0].startswith('172.'):
        raise ValueError('unexpected_control_network')
    return {**identity(item), 'phoneId': cfg['phoneId'], 'instance': number,
            'pid': item['State']['Pid'], 'primary': primary, 'control': control[0]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for side in ('a', 'b'):
        parser.add_argument('--' + side, required=True)
        parser.add_argument('--' + side + '-id', required=True)
    args = parser.parse_args()
    original = [inspect(args.a, args.a_id), inspect(args.b, args.b_id)]
    if args.a_id == args.b_id:
        raise ValueError('distinct_phones_required')
    phones = [phone(value) for value in original]
    probes = []
    for source, target in (phones, phones[::-1]):
        for kind, port in (('operator', 8442 + target['instance']), ('adb', 6519 + target['instance'])):
            # A local positive connection proves the precise peer service is up.
            command(['nsenter', '-t', str(target['pid']), '-n', 'python3', '-c',
                'import socket; s=socket.create_connection(("127.0.0.1",' + str(port) + '),2); s.close()'])
            for network, cidr in (('primary', '192.168.0.0/16'),):
                before = counters(source['pid'])
                result = subprocess.run(['docker', 'exec', '--user', '10001:10001', '-e', 'HOME=/phone/home', source['name'],
                    '/opt/cuttlefish/bin/adb', '-s', '127.0.0.1:' + str(6519 + source['instance']),
                    'shell', 'toybox', 'nc', '-z', '-w', '2', target[network], str(port)], capture_output=True, timeout=8)
                changes = rejection_deltas(before, counters(source['pid']), cidr)
                # Only explicit measured rejections count for this pair probe.
                probes.append({'fromPhone': source['phoneId'], 'toPhone': target['phoneId'],
                    'network': network, 'address': target[network], 'service': kind, 'port': port,
                    'peerServiceListening': True, 'exitCode': result.returncode,
                    'rejectionCounters': changes, 'passed': result.returncode != 0 and bool(changes)})
    unchanged = all(identity(before) == identity(inspect(before['Name'].lstrip('/'), before['Id'])) for before in original)
    passed = unchanged and all(v['passed'] for v in probes)
    print(json.dumps({'schemaVersion': 1, 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'status': 'passed' if passed else 'failed', 'phones': [{k:v for k,v in p.items() if k != 'pid'} for p in phones],
        'probes': probes, 'identitiesPreserved': unchanged,
        'claimBoundary': {'actualSecondPhone': True, 'dnsChangesTested': False, 'pressureStopTested': False, 'task3_5Accepted': False}}, indent=2))
    return 0 if passed else 1


if __name__ == '__main__':
    raise SystemExit(main())

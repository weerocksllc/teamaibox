import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


network = load('phone_network', 'deploy/android/cuttlefish/phone_network.py')
roles = load('phone_network_roles', 'services/node-agent/internal/docker/phone_network_roles.py')


class PhoneNetworkRolesTests(unittest.TestCase):
    def fixture(self, primary='eth1', installed='eth0'):
        state = {'raw': network.rules(21, True, installed)[0], 'writes': []}
        def run(args, data=None):
            if 'address' in args:
                return json.dumps([{'ifname': interface, 'addr_info': [
                    {'family': 'inet', 'local': '192.168.80.2' if interface == primary else '172.21.0.3'}]}
                    for interface in ('eth0', 'eth1')]).encode()
            if 'route' in args:
                return json.dumps([{'dev': primary, 'gateway': '192.168.80.1'}]).encode()
            if args[0].endswith('iptables-save'):
                return state['raw'].encode()
            if args[0].endswith('iptables-restore'):
                state['writes'].append((args, data))
                if '--test' not in args:
                    state['raw'] = data.decode()
                return b''
            self.fail(args)
        return state, run

    def test_both_attach_orders_and_idempotence(self):
        for primary in ('eth0', 'eth1'):
            for installed in ('eth0', 'eth1'):
                state, run = self.fixture(primary, installed)
                result = roles.reconcile(21, '192.168.80.2', '172.21.0.3', network, run)
                self.assertEqual(result['changed'], primary != installed)
                self.assertEqual(roles.normalized(state['raw'], network), roles.normalized(network.rules(21, True, primary)[0], network))
                writes = len(state['writes'])
                self.assertFalse(roles.reconcile(21, '192.168.80.2', '172.21.0.3', network, run)['changed'])
                self.assertEqual(len(state['writes']), writes)

    def test_iptables_formatting_is_not_semantic_drift(self):
        raw = network.rules(21, True)[0]
        formatted = raw.replace('-p tcp --dport', '-p tcp -m tcp --dport').replace('-p udp --sport', '-p udp -m udp --sport')
        formatted = formatted.replace('ESTABLISHED,RELATED', 'RELATED,ESTABLISHED').replace('-j REJECT', '-j REJECT --reject-with icmp-port-unreachable')
        formatted = formatted.replace('[0:0]', '[123:456]')
        self.assertEqual(roles.normalized(raw, network), roles.normalized(formatted, network))

    def test_docker_loopback_dns_is_retained(self):
        state, run = self.fixture()
        dns = ':DOCKER_OUTPUT - [0:0]\n:DOCKER_POSTROUTING - [0:0]\n'
        dns += '-A OUTPUT -d 127.0.0.11/32 -j DOCKER_OUTPUT\n-A POSTROUTING -d 127.0.0.11/32 -j DOCKER_POSTROUTING\n'
        for protocol, port in (('tcp', 45927), ('udp', 56335)):
            dns += f'-A DOCKER_OUTPUT -d 127.0.0.11/32 -p {protocol} -m {protocol} --dport 53 -j DNAT --to-destination 127.0.0.11:{port}\n'
            dns += f'-A DOCKER_POSTROUTING -s 127.0.0.11/32 -p {protocol} -m {protocol} --sport {port} -j SNAT --to-source :53\n'
        state['raw'] = state['raw'].replace('*nat\n', '*nat\n' + dns)
        roles.reconcile(21, '192.168.80.2', '172.21.0.3', network, run)
        self.assertIn(dns, state['raw'])
        self.assertIn('-o eth1 -j MASQUERADE', state['raw'])

    def test_foreign_rules_and_addresses_never_mutate(self):
        for drift in ('accept', 'wrong_port', 'reordered', 'foreign_chain'):
            state, run = self.fixture()
            if drift == 'accept': state['raw'] = state['raw'].replace(':INPUT DROP', ':INPUT ACCEPT')
            if drift == 'wrong_port': state['raw'] = state['raw'].replace('20000:20049', '1:65535')
            if drift == 'reordered': state['raw'] = state['raw'].replace('-A INPUT -i lo -j ACCEPT', '-A INPUT -i eth0 -j ACCEPT')
            if drift == 'foreign_chain': state['raw'] = state['raw'].replace(':PHONE_PUBLIC -', ':OTHER -')
            with self.assertRaises(RuntimeError): roles.reconcile(21, '192.168.80.2', '172.21.0.3', network, run)
            self.assertFalse(state['writes'])
        for primary in ('8.8.8.8', '127.0.0.1', '172.21.0.3', '192.168.80.99'):
            state, run = self.fixture()
            with self.assertRaises(RuntimeError): roles.reconcile(21, primary, '172.21.0.3', network, run)
            self.assertFalse(state['writes'])

    def test_failed_readback_restores_original_rules(self):
        state, real_run = self.fixture()
        original = state['raw']
        reads = 0
        def run(args, data=None):
            nonlocal reads
            if args[0].endswith('iptables-save'):
                reads += 1
                if reads == 2: return original.encode()
            return real_run(args, data)
        with self.assertRaises(RuntimeError): roles.reconcile(21, '192.168.80.2', '172.21.0.3', network, run)
        self.assertEqual(state['raw'], original)
        self.assertEqual(len(state['writes']), 3)

    def test_readonly_verification_does_not_repair(self):
        state, run = self.fixture()
        with self.assertRaises(RuntimeError):
            roles.reconcile(21, '192.168.80.2', '172.21.0.3', network, run, allow_change=False)
        self.assertFalse(state['writes'])


if __name__ == '__main__': unittest.main()

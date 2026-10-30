#!/usr/bin/env python3
"""Run ONLY via unshare --net: exercise real TCP/UDP NAT without touching LAN."""
import json
import os
import subprocess
import sys
from appliance_phone_media import apply_rules, rules


def run(*args):
    return subprocess.check_output(args, text=True, timeout=15)


def main():
    if os.readlink('/proc/self/ns/net') == os.readlink('/proc/1/ns/net'):
        raise RuntimeError('isolated_network_namespace_required')
    peers = []
    try:
        for prefix, network in [('lan', '10.222.1'), ('guest', '10.222.2')]:
            peer = subprocess.Popen(['unshare', '--net', 'sleep', '120'])
            peers.append(peer)
            # Wait for the child to enter its new namespace before moving link.
            import time
            for _ in range(100):
                if os.readlink(f'/proc/{peer.pid}/ns/net') != os.readlink('/proc/self/ns/net'): break
                time.sleep(.01)
            run('ip', 'link', 'add', prefix, 'type', 'veth', 'peer', 'name', prefix+'p')
            run('ip', 'link', 'set', prefix+'p', 'netns', str(peer.pid))
            run('ip', 'addr', 'add', network+'.1/24', 'dev', prefix)
            run('ip', 'link', 'set', prefix, 'up')
            def ns(*args): return run('nsenter', '-t', str(peer.pid), '-n', *args)
            ns('ip', 'link', 'set', 'lo', 'up'); ns('ip', 'link', 'set', prefix+'p', 'up')
            ns('ip', 'addr', 'add', network+'.2/24', 'dev', prefix+'p')
            ns('ip', 'route', 'add', 'default', 'via', network+'.1')
        run('ip', 'addr', 'add', '10.222.1.9/24', 'dev', 'lan')
        run('sysctl', '-w', 'net.ipv4.ip_forward=1')
        run('iptables', '-t', 'nat', '-N', 'DOCKER')
        run('iptables', '-N', 'DOCKER-USER'); run('iptables', '-A', 'FORWARD', '-j', 'DOCKER-USER')
        run('iptables', '-P', 'FORWARD', 'DROP')
        server = """import socket,threading,time
def udp():
 s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('0.0.0.0',20200))
 while True:
  b,a=s.recvfrom(4096);s.sendto(b,a)
def tcp(port):
 s=socket.socket();s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);s.bind(('0.0.0.0',port));s.listen()
 while True:
  c,a=s.accept();c.sendall(c.recv(4096));c.close()
for target,args in [(udp,()),(tcp,(20200,)),(tcp,(8443,))]:threading.Thread(target=target,args=args,daemon=True).start()
print('ready',flush=True);time.sleep(100)
"""
        service = subprocess.Popen(['nsenter', '-t', str(peers[1].pid), '-n', 'python3', '-u', '-c', server], stdout=subprocess.PIPE, text=True)
        peers.append(service)
        assert service.stdout.readline().strip() == 'ready'
        time.sleep(.1)
        client = """import socket,sys
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM if sys.argv[2]=='udp' else socket.SOCK_STREAM);s.settimeout(.5)
try:
 s.connect((sys.argv[1],int(sys.argv[3])));s.send(b'portable-media');assert s.recv(100)==b'portable-media';print('passed')
except (TimeoutError,ConnectionRefusedError):print('blocked')
"""
        def probe(address, protocol='udp', port=20200):
            return run('nsenter', '-t', str(peers[0].pid), '-n', 'python3', '-c', client, address, protocol, str(port)).strip()
        binding = {'run': {'containerAddress': '10.222.2.2', 'firstPort': 20200, 'lastPort': 20249}}
        results = {}
        for address in ('10.222.1.1', '10.222.1.9'):
            nat, forward = rules(binding, address, 'lan'); apply_rules(nat, forward); apply_rules(nat, forward)
            for protocol in ('tcp', 'udp'):
                results[address+protocol] = probe(address, protocol); assert results[address+protocol] == 'passed'
            assert probe(address, 'tcp', 8443) == 'blocked'
        assert probe('10.222.1.1') == 'blocked'
        apply_rules(*rules({}, None, ''))
        assert probe('10.222.1.9') == 'blocked'
        apply_rules(*rules(binding, '10.222.1.9', 'lan'))
        assert probe('10.222.1.9') == 'passed'
        print(json.dumps({'status':'passed','transfer':results,'oldAddressBlocked':True,'controlBlocked':True,'linkRecovery':True}))
    finally:
        for peer in reversed(peers): peer.terminate(); peer.wait(timeout=5)


if __name__ == '__main__': main()

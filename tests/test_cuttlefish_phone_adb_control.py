import importlib.util
from pathlib import Path
import socket
import sys
import threading
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'deploy/android/cuttlefish'))
from phone_adb_control import AdbControl, AdbPeer, relay
from phone_media_control import MediaError, MediaLeases


class AdbTests(unittest.TestCase):
    def setUp(self):
        self.now = 10.0
        self.wall = 1000.0
        self.config = {key: str(uuid.uuid4()) for key in ('phoneId', 'ownerId', 'volumeId', 'runId')}
        self.config.update(generation=1, version=1, buildId='16102939', instance=21)
        self.grant = {key: self.config[key] for key in ('phoneId', 'ownerId', 'runId', 'generation')}
        self.grant.update(id=str(uuid.uuid4()), sessionId=str(uuid.uuid4()), kind='adb')
        self.adb = AdbControl(self.config, clock=lambda: self.now, wall=lambda: self.wall)
        self.leases = self.adb.leases
        self.sockets = []

    def tearDown(self):
        self.adb.stop()
        for connection in self.sockets:
            connection.close()

    def pair(self):
        pair = socket.socketpair()
        self.sockets.extend(pair)
        for connection in pair:
            connection.settimeout(2)
        return pair

    def command(self, action, grant=None):
        request = {'action': action, 'grant': grant or self.grant}
        if action != 'close':
            request['leaseExpiresAt'] = int(self.wall*1000 + 4000)
        return self.leases.apply(request)

    def test_default_closed_and_kind_and_run_binding(self):
        self.assertIsNone(self.leases.active)
        self.assertEqual(self.adb.port, 6540)
        for key, value in (('kind', 'control'), ('runId', str(uuid.uuid4())), ('phoneId', str(uuid.uuid4())),
                           ('ownerId', str(uuid.uuid4())), ('generation', 2)):
            with self.assertRaises(MediaError):
                self.command('open', self.grant | {key: value})
        for instance in (0, 20, 21+(65535-20049)//100+1, 6540, True):
            with self.assertRaises(Exception):
                AdbControl(self.config | {'instance': instance})
        for instance in (23, 100, 21+(65535-20049)//100):
            extra = AdbControl(self.config | {'instance': instance})
            self.addCleanup(extra.stop)
            self.assertEqual(extra.port, 6519 + instance)
        self.assertTrue(self.command('open')['peerOpen'])
        self.assertEqual(self.leases.active['grant']['kind'], 'adb')

    def test_lease_expiry_closes_actual_data_sockets_without_streamer(self):
        self.command('open')
        client, left = self.pair()
        right, android = self.pair()
        value = self.adb.peer.attach(left, right)
        thread = threading.Thread(target=relay, args=value)
        thread.start()
        client.sendall(b'ADB request')
        self.assertEqual(android.recv(32), b'ADB request')
        android.sendall(b'Android result')
        self.assertEqual(client.recv(32), b'Android result')
        self.now += 4.1
        self.wall -= 30  # Wall-clock changes cannot extend a monotonic lease.
        self.leases.expire()
        self.assertEqual(client.recv(1), b'')
        self.assertEqual(android.recv(1), b'')
        thread.join(2)
        self.assertFalse(thread.is_alive())
        self.assertIsNone(self.leases.active)
        with self.assertRaisesRegex(MediaError, 'revoked'):
            self.command('open')

    def test_renew_then_revoke_is_exact_and_does_not_close_another_phone(self):
        other = AdbControl(self.config | {'phoneId': str(uuid.uuid4())})
        self.addCleanup(other.stop)
        client, left = self.pair()
        right, android = self.pair()
        other_value = other.peer.attach(left, right)
        self.command('open')
        a, b = self.pair()
        c, d = self.pair()
        value = self.adb.peer.attach(b, c)
        self.now += 3
        self.wall += 3
        self.command('renew')
        self.now += 2
        self.leases.expire()
        self.assertIsNotNone(self.leases.active)
        self.command('close')
        self.assertEqual(a.recv(1), b'')
        self.assertEqual(d.recv(1), b'')
        self.assertIs(other.peer.connection, other_value)
        client.sendall(b'still open')
        self.assertEqual(left.recv(32), b'still open')
        self.assertTrue(value[2].is_set())

    def test_single_debug_stream_and_late_detach_does_not_close_successor(self):
        a, b = self.pair()
        first = self.adb.peer.attach(a, b)
        c, d = self.pair()
        with self.assertRaisesRegex(MediaError, 'busy'):
            self.adb.peer.attach(c, d)
        self.adb.peer.close(self.adb.peer.current())
        second = self.adb.peer.attach(c, d)
        self.adb.peer.detach(first)
        self.assertIs(self.adb.peer.connection, second)
        c.sendall(b'ok')
        self.assertEqual(d.recv(2), b'ok')

    def test_slow_consumers_get_all_bytes_in_both_directions(self):
        client, left = self.pair()
        right, android = self.pair()
        for connection in self.sockets:
            connection.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
            connection.settimeout(8)
        stop = threading.Event()
        relay_thread = threading.Thread(target=relay, args=(left, right, stop))
        relay_thread.start()
        payload = bytes(range(256)) * 8192
        outcomes = []
        def send(connection, content):
            try:
                connection.sendall(content)
            except Exception as error:
                outcomes.append(error)
        def receive(connection, expected):
            value = bytearray()
            try:
                while len(value) < len(expected):
                    part = connection.recv(min(4096, len(expected)-len(value)))
                    if not part:
                        break
                    value.extend(part)
                    time.sleep(0.0002)
                outcomes.append(value == expected)
            except Exception as error:
                outcomes.append(error)
        workers = [threading.Thread(target=send, args=(client, payload)),
                   threading.Thread(target=send, args=(android, payload[::-1])),
                   threading.Thread(target=receive, args=(android, payload)),
                   threading.Thread(target=receive, args=(client, payload[::-1]))]
        for thread in workers:
            thread.start()
        for thread in workers:
            thread.join(10)
        stop.set()
        relay_thread.join(2)
        self.assertTrue(all(not thread.is_alive() for thread in workers))
        self.assertEqual(outcomes, [True, True])
        self.assertFalse(relay_thread.is_alive())

    def test_late_open_after_close_cannot_recreate_debug_stream(self):
        self.command('close')
        for action in ('open', 'renew'):
            with self.assertRaisesRegex(MediaError, 'revoked'):
                self.command(action)
        with self.assertRaises(MediaError):
            MediaLeases(self.config, kind='adb')


if __name__ == '__main__':
    unittest.main()

import json
import unittest
from check_public_source import inspect


class PublicSourceGuardTests(unittest.TestCase):
    def test_private_address_in_filename(self):
        self.assertIn('private-network-address-in-filename', inspect('deploy/host/frontdoor-10.23.45.67.json', b'{}'))
        self.assertEqual(inspect('deploy/example-192.0.2.10.json', b'{}'), [])

    def test_container_inventory_without_known_secret_marker(self):
        value = dict(retired=[], ordered=[dict(name='synthetic-service', id='0123456789abcdef' * 4)])
        self.assertIn('persisted-container-inventory', inspect('host.json', json.dumps(value).encode()))
        value['ordered'][0]['id'] = '1' * 64
        self.assertEqual(inspect('host.example.json', json.dumps(value).encode()), [])

    def test_website_and_default_credentials(self):
        self.assertIn('private-website-directory', inspect('website/index.html', b''))
        self.assertEqual(inspect('factory.json', b'{"username":"admin","password":"admin"}'), [])


if __name__ == '__main__':
    unittest.main()

import unittest
from secrets import token_hex
from validation_origin import is_https_origin


class ValidationOriginTests(unittest.TestCase):
    def test_explicit_origin(self):
        self.assertTrue(is_https_origin('https://appliance.example.test:9443'))
        self.assertTrue(is_https_origin('https://[::1]:9443'))
        self.assertTrue(is_https_origin('https://appliance.example.test/',trailing_slash=True))

    def test_rejects_ambiguous_or_credential_bearing_urls(self):
        for value in (None,'http://appliance.example.test',f'https://{token_hex(8)}:{token_hex(16)}@example.test',
                      'https://example.test/path','https://example.test?token=synthetic',
                      'https://example.test#fragment','https://example.test:99999',
                      'https://exa\nmple.test','https://example.test:0'):
            self.assertFalse(is_https_origin(value),repr(value))


if __name__=='__main__':unittest.main()

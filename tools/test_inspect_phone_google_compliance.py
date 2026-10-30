import hashlib
import json
import struct
import unittest
from inspect_phone_google_compliance import summarize_cache, fields


def v(n):
    out = bytearray()
    while n > 127:
        out.append((n & 127) | 128); n >>= 7
    return bytes(out + bytes([n]))


def integer(n, value):
    return v(n << 3) + v(value)


def blob(n, value):
    return v(n << 3 | 2) + v(len(value)) + value


def fixture(decision=1):
    body = integer(1, decision) + blob(2, integer(1, 1792320210)) + blob(3, integer(1, 1793090866))
    body += blob(4, integer(1, 1234567890123456789))
    body += blob(7, b'private-response-id-not-to-be-printed')
    signed = blob(1, body) + blob(4, b'signature-certificate') + blob(5, b'signature')
    return blob(1, signed)


class ComplianceMetadataTests(unittest.TestCase):
    def test_raw_and_store_envelopes_match(self):
        raw = fixture()
        a = summarize_cache(raw, 'gms')
        b = summarize_cache(struct.pack('>II', 1, len(raw)) + raw, 'play')
        for key in ('decision', 'issuedAt', 'expiresAt', 'gsfIdSha256'):
            self.assertEqual(a[key], b[key])
        self.assertEqual(a['decision'], 'ENFORCE')
        self.assertEqual(a['expiresAt'], '2026-10-27T08:47:46+00:00')
        self.assertFalse(a['signatureVerifiedByThisTool'])

    def test_allow_decision_is_not_certification_claim(self):
        self.assertEqual(summarize_cache(fixture(2), 'gms')['decision'], 'DO_NOT_ENFORCE')

    def test_private_identifiers_not_emitted(self):
        result = summarize_cache(fixture(), 'gms')
        output = json.dumps(result)
        self.assertNotIn('1234567890123456789', output)
        self.assertNotIn('private-response-id', output)
        self.assertEqual(result['gsfIdSha256'], hashlib.sha256(b'1234567890123456789').hexdigest())

    def test_unknown_decision_rejected(self):
        with self.assertRaisesRegex(ValueError, 'unknown_decision'):
            summarize_cache(fixture(99), 'gms')

    def test_truncated_and_wrong_header_rejected(self):
        for data in (b'', b'\0'*8, struct.pack('>II', 2, len(fixture())) + fixture()):
            with self.assertRaises(ValueError): summarize_cache(data, 'play')
        with self.assertRaises(ValueError): fields(b'\x0a\x05x')

    def test_duplicate_decision_rejected(self):
        body = integer(1, 1) + integer(1, 2)
        with self.assertRaises(ValueError): summarize_cache(blob(1, blob(1, body)), 'gms')


if __name__ == '__main__': unittest.main()

#!/usr/bin/env python3
"""Read only Google compliance cache metadata, never account/token contents.

Schema checked against the installed, original Play 53.5.48 / GMS 26.40.32
packages. This is diagnostic metadata, not independent signature verification
or proof of device certification. Unknown layouts fail rather than guess.
"""
import argparse
import datetime as dt
import hashlib
import json
import re
import struct
import subprocess

PATHS = {
    'play': '/data/user/0/com.android.vending/cache/gmscompliance.pb',
    'gms': '/data/user/0/com.google.android.gms/files/gmscompliance/shared/cache.pb',
}


def fields(data):
    if len(data) > 65536:
        raise ValueError('cache_too_large')
    pos = 0

    def varint():
        nonlocal pos
        value = 0
        for shift in range(0, 70, 7):
            if pos >= len(data):
                raise ValueError('truncated_varint')
            byte = data[pos]; pos += 1
            value |= (byte & 127) << shift
            if not byte & 128:
                return value
        raise ValueError('invalid_varint')

    result = {}
    while pos < len(data):
        tag = varint(); field, wire = tag >> 3, tag & 7
        if field == 0:
            raise ValueError('invalid_field')
        if wire == 0:
            value = varint()
        elif wire in (1, 2, 5):
            size = varint() if wire == 2 else 8 if wire == 1 else 4
            if pos + size > len(data):
                raise ValueError('truncated_field')
            value = data[pos:pos + size]; pos += size
        else:
            raise ValueError('unsupported_wire_type')
        result.setdefault(field, []).append((wire, value))
    return result


def one(message, field, wire):
    entries = message.get(field, [])
    if len(entries) != 1 or entries[0][0] != wire:
        raise ValueError('unexpected_field_layout')
    return entries[0][1]


def timestamp(message, field):
    seconds = one(fields(one(message, field, 2)), 1, 0)
    return dt.datetime.fromtimestamp(seconds, dt.timezone.utc).isoformat()


def summarize_cache(data, kind):
    if kind == 'play':
        if len(data) < 8:
            raise ValueError('truncated_cache_header')
        version, size = struct.unpack('>II', data[:8])
        if version != 1 or size != len(data) - 8:
            raise ValueError('unknown_cache_format')
        payload = data[8:]
    elif kind == 'gms':
        payload = data
    else:
        raise ValueError('unknown_cache_kind')
    signed = fields(one(fields(payload), 1, 2))
    verdict = fields(one(signed, 1, 2))
    decision = one(verdict, 1, 0)
    if decision not in (0, 1, 2):
        raise ValueError('unknown_decision')
    device = fields(one(verdict, 4, 2))
    gsf = str(one(device, 1, 0))
    return {
        'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
        'decision': {0: 'UNKNOWN', 1: 'ENFORCE', 2: 'DO_NOT_ENFORCE'}[decision],
        'issuedAt': timestamp(verdict, 2), 'expiresAt': timestamp(verdict, 3),
        'gsfIdSha256': hashlib.sha256(gsf.encode()).hexdigest(),
        'signatureEnvelopePresent': bool(signed.get(4)) and bool(signed.get(5)),
        'signatureVerifiedByThisTool': False,
    }


def inspect(container):
    if not re.fullmatch(r'teamaibox-phone-[0-9a-f-]{36}', container):
        raise ValueError('invalid_phone_container')
    result = {'at': dt.datetime.now(dt.timezone.utc).isoformat(), 'readOnly': True, 'caches': {}}
    for kind, path in PATHS.items():
        p = subprocess.run(['docker', 'exec', '-u', '10001', container,
                            '/opt/cuttlefish/bin/adb', 'exec-out', 'su', '0', 'cat', path],
                           capture_output=True, timeout=20)
        if p.returncode:
            result['caches'][kind] = {'readExitCode': p.returncode}
            continue
        try:
            result['caches'][kind] = summarize_cache(p.stdout, kind)
        except (ValueError, OverflowError) as error:
            result['caches'][kind] = {'parseError': str(error), 'bytes': len(p.stdout)}
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('container')
    print(json.dumps(inspect(parser.parse_args().container), indent=2))

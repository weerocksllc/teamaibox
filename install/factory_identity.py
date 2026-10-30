#!/usr/bin/env python3
"""Generate new installation identities; never import a development identity."""
from __future__ import annotations

import base64
import os
from pathlib import Path
import secrets
import tempfile
import uuid

from offline_common import atomic, need, read_json, run, write_json


def secret_file(row, root):
    from offline_common import within
    path = within(root, row['path'])
    mode, uid, gid = int(row.get('mode', '0600'), 8), row.get('uid', 0), row.get('gid', 0)
    if path.exists():
        info = path.stat()
        need(path.is_file() and not path.is_symlink() and info.st_mode & 0o777 == mode
             and (info.st_uid, info.st_gid) == (uid, gid), 'existing secret ownership/permissions conflict: ' + row['name'])
        return path
    encoding = row['format']
    if encoding == 'ed25519':
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with tempfile.TemporaryDirectory(prefix='.key-', dir=path.parent) as temporary:
            key = Path(temporary) / 'key'
            run(['openssl', 'genpkey', '-algorithm', 'ED25519', '-out', key])
            raw = key.read_bytes()
    else:
        raw = secrets.token_bytes(row['bytes'])
        raw = raw.hex().encode() if encoding == 'hex' else base64.b64encode(raw) if encoding == 'base64' else base64.urlsafe_b64encode(raw).rstrip(b'=')
    atomic(path, raw, mode)
    os.chown(path, uid, gid)
    return path


def tls_identity(directory, node_id, installation_id, runner=run):
    """One atomic directory publishes CA plus all mutually authenticated leaves.

    Public certificates are copied into narrowly mounted configuration trees by
    the recipe. The CA private key is never mounted into a product container.
    """
    uuid.UUID(node_id)
    uuid.UUID(installation_id)
    directory = Path(directory)
    need(not directory.is_symlink(), 'TLS directory must not be a symlink')
    roles = {
        'node': 'spiffe://teamaibox.local/node/' + node_id,
        'scheduler': 'spiffe://teamaibox.local/controller/platform',
        'gateway': 'spiffe://teamaibox.local/node/' + node_id,
        'maintenance': 'spiffe://teamaibox.local/controller/platform',
    }
    identity = dict(nodeId=node_id, installationId=installation_id)
    if directory.exists():
        need((directory / 'identity.json').is_file() and read_json(directory / 'identity.json') == identity,
             'unregistered or different TLS identity preserved')
        for name in ('ca', *roles):
            for suffix in ('key', 'crt'):
                p = directory / (name + '.' + suffix)
                need(p.is_file() and not p.is_symlink(), 'incomplete TLS identity preserved')
            if name != 'ca':
                runner(['openssl', 'verify', '-CAfile', directory / 'ca.crt', directory / (name + '.crt')])
        return
    directory.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(prefix='.identity-', dir=directory.parent) as temporary:
        stage = Path(temporary) / 'identity'
        stage.mkdir(mode=0o700)
        runner(['openssl', 'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '3650',
                '-subj', '/CN=Team AI Box internal ' + installation_id,
                '-keyout', stage / 'ca.key', '-out', stage / 'ca.crt',
                '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
        for name, uri in roles.items():
            runner(['openssl', 'req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost',
                    '-keyout', stage / (name + '.key'), '-out', stage / (name + '.csr')])
            extensions = ('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
                          'extendedKeyUsage=serverAuth,clientAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1,URI:' + uri + '\n')
            atomic(stage / 'extensions', extensions.encode())
            runner(['openssl', 'x509', '-req', '-in', stage / (name + '.csr'), '-CA', stage / 'ca.crt',
                    '-CAkey', stage / 'ca.key', '-set_serial', '0x' + secrets.token_hex(16), '-days', '3650',
                    '-sha256', '-extfile', stage / 'extensions', '-out', stage / (name + '.crt')])
            (stage / (name + '.csr')).unlink()
        (stage / 'extensions').unlink()
        for name in ('ca', *roles):
            (stage / (name + '.key')).chmod(0o600)
            (stage / (name + '.crt')).chmod(0o644)
        write_json(stage / 'identity.json', identity)
        # A partially generated identity is never a reusable live identity.
        os.rename(stage, directory)


def install_tls_copies(rows, identity, root):
    from offline_common import within
    for row in rows:
        need(row['source'] in {n + suffix for n in ('ca', 'node', 'scheduler', 'gateway', 'maintenance')
                              for suffix in ('.crt', '.key')} and row['source'] != 'ca.key',
             'CA private key cannot be mounted into a service')
        source, target = identity / row['source'], within(root, row['path'])
        raw, mode = source.read_bytes(), int(row.get('mode', '0600' if row['source'].endswith('.key') else '0644'), 8)
        if target.exists():
            need(not target.is_symlink() and target.read_bytes() == raw, 'existing service TLS identity differs')
        else:
            atomic(target, raw, mode)
        os.chown(target, row.get('uid', 0), row.get('gid', 0))
        os.chmod(target, mode)

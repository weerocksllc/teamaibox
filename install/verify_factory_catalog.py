#!/usr/bin/env python3
"""Validate fresh schema/catalog only in a new networkless, tmpfs PostgreSQL.

Uses one explicitly provided local image. No customer database or GPU is opened.
The exact newly created test container is removed after the report is saved.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

from offline_common import digest, need, read_json, run, write_json
from factory_guest_catalog import statements, sql_value


def verify(image, migrations, report_directory, scope='guests'):
    actual = json.loads(run(['docker', 'image', 'inspect', image]))[0]
    need(actual['Id'] == image and actual['Os'] == 'linux' and actual['Architecture'] == 'arm64', 'exact local ARM64 PostgreSQL required')
    manifest = read_json(migrations / 'manifest.json')
    for row in manifest['migrations']:
        need(digest(migrations / row['up']) == row['upSha256'], 'migration checksum differs')
    report_directory.mkdir(parents=True, exist_ok=False)
    test_id = str(uuid.uuid4())
    name = 'teamaibox-factory-catalog-test-' + test_id
    report = dict(testId=test_id, status='incomplete', network='none', customerDataAccessed=False,
                  gpuUsed=False, imageId=image, migrationManifestSha256=digest(migrations / 'manifest.json'))
    cid = None
    try:
        cid = run(['docker', 'run', '-d', '--name', name, '--pull=never', '--network=none',
            '--label', 'com.teamaibox.installation-test=' + test_id,
            '--read-only', '--user=999:999', '--memory=768m', '--pids-limit=128',
            '--tmpfs=/var/lib/postgresql:rw,uid=999,gid=999,mode=0700,size=512m',
            '--tmpfs=/var/run/postgresql:rw,uid=999,gid=999,mode=0700,size=16m',
            '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m',
            '-e', 'PGDATA=/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust',
            '-e', 'POSTGRES_USER=installer_test', '-e', 'POSTGRES_DB=installer_test',
            '--entrypoint=docker-entrypoint.sh', image, 'postgres', '-c', 'max_connections=10',
            '-c', 'shared_buffers=32MB']).strip()
        psql = ['docker', 'exec', '-i', cid, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
                '-U', 'installer_test', '-d', 'installer_test', '-f', '-']
        def sql(text, must_succeed=True):
            value = subprocess.run(psql, input=text, text=True, capture_output=True, timeout=120)
            if must_succeed:
                need(value.returncode == 0, 'empty-database check failed: ' + value.stderr[-1600:])
                return value.stdout.strip()
            need(value.returncode != 0, 'expected conflicting registration to be rejected')
            return value.stderr
        deadline = time.monotonic() + 45
        while subprocess.run(['docker', 'exec', cid, 'pg_isready', '-U', 'installer_test'], capture_output=True, timeout=3).returncode:
            need(time.monotonic() < deadline, 'new test PostgreSQL startup timed out')
            time.sleep(.5)
        for row in manifest['migrations']:
            sql('BEGIN;\n' + (migrations / row['up']).read_text() + '\n' +
                'INSERT INTO public.teamaibox_schema_migrations(version,name,sha256,execution_milliseconds) VALUES (' +
                ','.join(sql_value(row[k]) for k in ('version', 'name', 'upSha256')) + ',0);\nCOMMIT;')
        node_id = str(uuid.uuid4())
        sql("INSERT INTO compute.nodes(id,node_key,architecture,trust_kind,lifecycle_state,appliance_role,bootstrap_admission_required) VALUES (" +
            sql_value(node_id) + ",'localhost','arm64','managed_appliance','joining','appliance-core',false);")
        if scope == 'office':
            from test_factory_office_catalog import fixture
            from factory_office_catalog import documents, statements as office_statements
            runtime, release, identity = fixture()
            docs = documents(runtime, release, identity, '2026-10-24T00:00:00.000Z')
            sql(office_statements(runtime, docs))
            snapshot = sql('SELECT json_agg(p ORDER BY p.id) FROM compute.model_profiles p; '
                           'SELECT json_agg(r ORDER BY r.profile_id) FROM compute.model_profile_registrations r;')
            sql(office_statements(runtime, docs))
            sql(office_statements(runtime, docs, check=True))
            after = sql('SELECT json_agg(p ORDER BY p.id) FROM compute.model_profiles p; '
                        'SELECT json_agg(r ORDER BY r.profile_id) FROM compute.model_profile_registrations r;')
            need(snapshot == after, 'repeat office registration changed rows')
            import copy
            conflict = copy.deepcopy(docs)
            conflict['assistant']['artifactDigest'] = 'sha256:' + 'e' * 64
            sql(office_statements(runtime, conflict), must_succeed=False)
            sql(office_statements(runtime, docs, check=True))
            need(sql('SELECT count(*) FROM compute.model_profiles;') == '6', 'office profiles incomplete')
            need(sql("SELECT count(*) FROM compute.model_profiles WHERE certification_state='certified';") == '0',
                 'installation fabricated certification')
            report.update(status='passed', scope='office', schemaVersion=manifest['migrations'][-1]['version'],
                          profiles=6, catalogIdempotent=True, conflictingProfileRejected=True,
                          certificationsFabricated=False)
            return report
        roms = [dict(id='factory-test-' + family, family_id=family, display_name='Installer fixture',
            version_label='Android 17', base_build_id='16102939', runtime_image_digest='sha256:' + str(i + 1) * 64,
            google_play=bool(i), experimental=bool(i), camera_capability='verified', create_enabled=True)
            for i, family in enumerate(('aosp', 'google-experimental'))]
        pool = 'pool-' + test_id
        capacity = dict(total=8 * 1024**3, available=7 * 1024**3)
        sql(statements(node_id, pool, roms, capacity))
        snapshot = sql("SELECT json_agg(p ORDER BY p.id) FROM platform.phone_rom_versions p; SELECT json_agg(p ORDER BY p.pool_id) FROM objects.storage_pools p;")
        sql(statements(node_id, pool, roms, capacity))
        sql(statements(node_id, pool, roms, capacity, check=True))
        after = sql("SELECT json_agg(p ORDER BY p.id) FROM platform.phone_rom_versions p; SELECT json_agg(p ORDER BY p.pool_id) FROM objects.storage_pools p;")
        need(after == snapshot, 'repeat registration changed existing catalog')
        conflicting = [dict(row) for row in roms]
        conflicting[0]['runtime_image_digest'] = 'sha256:' + 'f' * 64
        sql(statements(node_id, pool, conflicting, capacity), must_succeed=False)
        sql(statements(node_id, pool, roms, capacity, check=True))
        counts = sql(
            'SELECT count(*) FROM iam.identities; SELECT count(*) FROM platform.phones; SELECT count(*) FROM platform.computers;')
        need(counts.split() == ['0', '0', '0'], 'new installation seeded a user or guest')
        report.update(status='passed', schemaVersion=manifest['migrations'][-1]['version'],
                      catalogIdempotent=True, conflictingRomRejected=True,
                      customerAccountsCreated=0, phonesCreated=0, computersCreated=0)
    finally:
        if cid:
            c = json.loads(run(['docker', 'inspect', cid]))[0]
            need(c['Id'] == cid and c['Name'] == '/' + name
                 and c['Config']['Labels'].get('com.teamaibox.installation-test') == test_id,
                 'test ownership changed; automatic cleanup refused')
            run(['docker', 'rm', '-f', '-v', cid])
            report['temporaryContainerRemoved'] = True
        write_json(report_directory / 'report.json', report, 0o644)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--migrations', type=Path, required=True)
    parser.add_argument('--report-directory', type=Path, required=True)
    parser.add_argument('--scope', choices=('guests', 'office'), default='guests')
    args = parser.parse_args()
    need(os.geteuid() == 0, 'root required for isolated Docker validation')
    print(json.dumps(verify(args.image, args.migrations.resolve(), args.report_directory.resolve(), args.scope), indent=2))

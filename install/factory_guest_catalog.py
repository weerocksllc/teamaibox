#!/usr/bin/env python3
"""Register only the new installation's guest pool and clean ROM metadata.

No account, phone, computer, guest disk or logged-in Android state is copied.
The caller must finish storage initialization and database migrations first.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from offline_common import need, read_json, run
from factory_bootstrap import pool_identity

ROM_FIELDS = ('id', 'family_id', 'display_name', 'version_label', 'base_build_id',
              'runtime_image_digest', 'google_play', 'experimental', 'camera_capability', 'create_enabled')


def sql_value(value):
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if type(value) is int:
        return str(value)
    need(isinstance(value, str) and '\x00' not in value, 'invalid catalog value')
    return "'" + value.replace("'", "''") + "'"


def statements(node_id, pool, roms, capacity, check=False, computers=None):
    need(len(roms) == 2 and {r['family_id'] for r in roms} == {'aosp', 'google-experimental'}, 'two product systems required')
    need(all(set(r) == set(ROM_FIELDS) for r in roms), 'ROM metadata contract differs')
    need(capacity['total'] >= capacity['available'] >= 0, 'storage observation invalid')
    q = sql_value
    computers = computers or []
    need(len(computers) == 2 and {p['osFamily'] for p in computers} == {'windows', 'linux'},
         'two user-ISO computer profiles required')
    need(all(p['schemaVersion'] == 2 and p['mediaDigest'] is None for p in computers),
         'factory computer profiles must not contain preinstalled media')
    ids = ','.join(q(r['id']) for r in roms)
    assertions = [f"IF NOT EXISTS (SELECT 1 FROM compute.nodes WHERE id={q(node_id)}) THEN RAISE EXCEPTION 'local node missing'; END IF;"]
    for r in roms:
        predicate = ' AND '.join(field + '=' + q(r[field]) for field in ROM_FIELDS)
        assertions.append("IF NOT EXISTS (SELECT 1 FROM platform.phone_rom_versions WHERE " + predicate
                          + ") THEN RAISE EXCEPTION 'installed ROM metadata differs'; END IF;")
    assertions += [f"IF NOT EXISTS (SELECT 1 FROM objects.storage_pools WHERE pool_id={q(pool)} AND node_id={q(node_id)} AND backend_kind='local-block' AND encryption_mode='luks2' AND encryption_status='verified' AND compatibility_status='verified') THEN RAISE EXCEPTION 'guest pool differs'; END IF;",
                   f"IF EXISTS (SELECT 1 FROM platform.phone_rom_versions WHERE create_enabled AND id NOT IN ({ids})) THEN RAISE EXCEPTION 'unexpected creatable ROM'; END IF;"]
    for profile in computers:
        assertions.append(f"IF NOT EXISTS (SELECT 1 FROM platform.computer_profiles WHERE id={q(profile['id'])} AND profile={q(json.dumps(profile))}::jsonb AND create_enabled) THEN RAISE EXCEPTION 'installed computer profile differs'; END IF;")
    # Existing computer reservations reuse the guest pool directly; the
    # storage-class schema has no "computer-data" value. Do not invent one or
    # relax the object/guest segregation when initializing a new appliance.
    for kind in ('phone-data',):
        assertions.append(f"IF NOT EXISTS (SELECT 1 FROM objects.storage_pool_data_classes WHERE pool_id={q(pool)} AND data_class={q(kind)}) THEN RAISE EXCEPTION 'guest storage class missing'; END IF;")
    if check:
        return 'BEGIN READ ONLY;\nDO $check$ BEGIN\n' + '\n'.join(assertions) + '\nEND $check$;\nCOMMIT;\n'
    # Only generated catalog versions and this installation's pool are added.
    # A conflicting row is not overwritten: the assertions roll back the entire
    # transaction. Legacy migration seed ROMs are hidden, not removed.
    sql = ['BEGIN;', "SELECT pg_advisory_xact_lock(hashtextextended('teamaibox-factory-guests',0));"]
    sql += ["INSERT INTO platform.phone_rom_versions (" + ','.join(ROM_FIELDS) + ') VALUES ('
            + ','.join(q(r[f]) for f in ROM_FIELDS) + ') ON CONFLICT(id) DO NOTHING;' for r in roms]
    sql.append(f"UPDATE platform.phone_rom_versions SET create_enabled=false WHERE create_enabled AND id NOT IN ({ids});")
    for profile in computers:
        sql.append(f"INSERT INTO platform.computer_profiles(id,profile,create_enabled) VALUES ({q(profile['id'])},{q(json.dumps(profile))}::jsonb,true) ON CONFLICT(id) DO NOTHING;")
    sql.append(f"""INSERT INTO objects.storage_pools
        (pool_id,display_name,backend_kind,node_id,failure_domain,health_state,total_bytes,available_bytes,
         safety_reserve_bytes,encryption_mode,encryption_status,encryption_verified_at,
         compatibility_status,compatibility_verified_at,observed_at)
        VALUES ({q(pool)},'Virtual devices','local-block',{q(node_id)},{q(pool)},'healthy',
          {q(capacity['total'])},{q(capacity['available'])},0,'luks2','verified',clock_timestamp(),
          'verified',clock_timestamp(),clock_timestamp()) ON CONFLICT(pool_id) DO NOTHING;""")
    for kind in ('phone-data',):
        sql.append(f"INSERT INTO objects.storage_pool_data_classes(pool_id,data_class) VALUES ({q(pool)},{q(kind)}) ON CONFLICT DO NOTHING;")
    sql += ['DO $check$ BEGIN\n' + '\n'.join(assertions) + '\nEND $check$;', 'COMMIT;']
    return '\n'.join(sql) + '\n'


def apply(root, check=False):
    from appliance_installation import load, resolve
    from factory_database import target
    from restore_existing_business_volumes import restore
    state = read_json(root / 'install-state.json')
    record = load(root / 'installation.json')
    need(record['installationId'] == state['installationId'] and record['nodeId'] == state['nodeId'], 'installation identity differs')
    postgres = resolve(record, 'postgres')
    labels = postgres['Config'].get('Labels') or {}
    need(labels.get('com.teamaibox.installation-id') == state['installationId'], 'database is not owned by this installation')
    need(target(root) == postgres['Id'], 'database does not use new installation storage')
    volumes = read_json(root / 'storage-volumes.json')['volumes']
    for volume in volumes:
        restore(volume, check_only=True)
    roms = read_json(root / 'config/guest-catalog.json')
    stats = os.statvfs(root / 'data')
    capacity = dict(total=stats.f_blocks * stats.f_frsize, available=stats.f_bavail * stats.f_frsize)
    computers = read_json(root / 'config/computer-catalog.json')
    sql = statements(record['nodeId'], pool_identity(state['installationId']), roms, capacity, check, computers)
    process = subprocess.run(['docker', 'exec', '-i', postgres['Id'], 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
                              '-U', 'teamaibox', '-d', 'teamaibox'], input=sql, capture_output=True, text=True, timeout=60)
    need(process.returncode == 0, 'new guest catalog registration/check failed: ' + process.stderr[-2000:])
    return dict(status='checked' if check else 'registered', accountsCreated=0, phonesCreated=0, computersCreated=0)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--installation-root', type=Path, required=True)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    need(os.geteuid() == 0, 'root required')
    print(json.dumps(apply(args.installation_root.resolve(), args.check)))

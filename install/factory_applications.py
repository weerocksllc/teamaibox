"""Register shipped application metadata, with live readiness and no user data."""
import hashlib
import json
import uuid

from offline_common import need, read_json, run
from factory_guest_catalog import sql_value as q


def statements(installation_id, applications, check=False):
    namespace = uuid.UUID(installation_id)
    sql, assertions = [], []
    keys = [r['manifest']['id'] for r in applications]
    need(len(keys) == 9 and len(set(keys)) == 9, 'complete official application catalog required')
    for row in applications:
        manifest = row['manifest']
        key, version = manifest['id'], manifest['version']
        need(key.startswith('official.') and manifest['type'] == 'ApplicationPlugin'
             and 'signature' not in manifest, 'invalid shipped application manifest')
        raw = json.dumps(manifest, sort_keys=True, separators=(',', ':'))
        need('__RELEASE_PIPELINE' not in raw and '@@' not in raw, 'unresolved application metadata')
        plugin_id = str(uuid.uuid5(namespace, 'application:' + key))
        version_id = str(uuid.uuid5(namespace, 'application:' + key + ':' + version))
        checksum = hashlib.sha256(raw.encode()).hexdigest()
        sql += [f"INSERT INTO plugins.plugins(id,plugin_key,plugin_type,publisher,data_namespace) VALUES ({q(plugin_id)},{q(key)},'application',{q(manifest['publisher']['displayName'])},{q('factory.' + installation_id + '.' + key)}) ON CONFLICT DO NOTHING;",
                f"INSERT INTO plugins.plugin_versions(id,plugin_id,version,manifest,manifest_sha256,supply_chain_state,install_state,slot,health,activated_at) VALUES ({q(version_id)},{q(plugin_id)},{q(version)},{q(raw)}::jsonb,decode({q(checksum)},'hex'),'verified','healthy','blue','{{\"healthy\":true}}',clock_timestamp()) ON CONFLICT DO NOTHING;",
                f"INSERT INTO plugins.runtime_slots(plugin_id,slot,plugin_version_id,slot_state,health,generation) VALUES ({q(plugin_id)},'blue',{q(version_id)},'active','{{\"healthy\":true}}',1) ON CONFLICT DO NOTHING;",
                f"UPDATE plugins.plugins SET current_version_id={q(version_id)},active_slot='blue',lifecycle_state='enabled',generation=1 WHERE id={q(plugin_id)} AND lifecycle_state='discovered' AND current_version_id IS NULL;"]
        assertions.append(f"IF NOT EXISTS (SELECT 1 FROM plugins.plugins p JOIN plugins.plugin_versions v ON v.id=p.current_version_id JOIN plugins.runtime_slots s ON s.plugin_id=p.id AND s.slot=p.active_slot WHERE p.id={q(plugin_id)} AND p.plugin_key={q(key)} AND p.lifecycle_state='enabled' AND v.id={q(version_id)} AND v.manifest={q(raw)}::jsonb AND v.manifest_sha256=decode({q(checksum)},'hex') AND v.install_state='healthy' AND s.slot_state='active' AND s.plugin_version_id=v.id) THEN RAISE EXCEPTION 'factory application metadata conflicts'; END IF;")
    return '\n'.join(['BEGIN READ ONLY;' if check else 'BEGIN;',
        *([] if check else ["SELECT pg_advisory_xact_lock(hashtextextended('teamaibox-factory-applications',0));", *sql]),
        'DO $check$ BEGIN', *assertions, 'END $check$;', 'COMMIT;'])


def apply(root, check=False):
    from appliance_installation import load
    from factory_database import query
    record = load(root / 'installation.json')
    rows = read_json(root / 'config/application-catalog.json')['applications']
    for row in rows:
        ids = run(['docker', 'ps', '-q', '--filter', 'label=com.teamaibox.installation-id=' + record['installationId'],
                   '--filter', 'label=com.teamaibox.service-role=' + row['role']]).split()
        need(len(ids) == 1, 'shipped application is not uniquely running')
        container = json.loads(run(['docker', 'inspect', ids[0]]))[0]
        need(container['Config']['Labels'].get('com.teamaibox.installation-id') == record['installationId'],
             'application does not belong to this installation')
        need(container['Image'] == row['manifest']['images'][0]['variants'][0]['digest'],
             'shipped application image differs from package')
        probe = json.loads(run(['docker', 'exec', container['Id'], 'node', '-e',
            "fetch('http://127.0.0.1:8080/health/ready',{signal:AbortSignal.timeout(5000)}).then(async r=>{if(!r.ok)throw Error('not ready');console.log(JSON.stringify(await r.json()))}).catch(()=>process.exit(1))"]))
        need(probe.get('status') == 'ready' and probe.get('pluginId') == row['manifest']['id']
             and probe.get('version') == row['manifest']['version'], 'shipped application is not ready')
    query(root, statements(record['installationId'], rows, check))
    return dict(status='checked' if check else 'registered', applications=len(rows), accountsCreated=0)

"""Bounded database operations shared by single-appliance maintenance tools.

Historical job, model-validation and audit anchors remain unchanged by schema
maintenance. This module does not register targets or seed placement groups.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path

try:
    from .appliance_operations import Remote
    from .appliance_target import ssh_target, postgres_target
except ImportError:
    from appliance_operations import Remote
    from appliance_target import ssh_target, postgres_target

ROOT = Path(__file__).resolve().parents[1]
class ExplicitRemote:
    def run(self, arguments, timeout=120):
        return Remote(ssh_target()).run(arguments, check=False, timeout=timeout)

REMOTE = ExplicitRemote()
HISTORICAL_TABLES = (
    'compute.jobs', 'compute.attempts', 'compute.job_events',
    'compute.model_validation_runs', 'compute.model_validation_stages',
    'compute.model_validation_operations', 'audit.audit_references',
)

class DeploymentError(RuntimeError):
    pass

def digest_file(path: Path) -> str:
    return 'sha256:' + hashlib.sha256(path.read_bytes()).hexdigest()

def sql_text(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"

def remote_psql(statement: str, *, timeout: int = 180) -> str:
    if not 0 < len(statement.encode('utf-8')) <= 512 * 1024:
        raise DeploymentError('database statement is unbounded')
    selected=postgres_target()
    expected=os.environ.get('PLATFORM_APPLIANCE_NODE_ID') or os.environ.get('TEAMAIBOX_APPLIANCE_NODE_ID')
    # Resolve against the selected host's root-owned installation, before SQL.
    # The remote prints only its node and exact database ID/name, never env.
    code="import sys,json;sys.path.insert(0,'/usr/local/lib/teamaibox');from appliance_installation import load,resolve;r=load();c=resolve(r,'postgres');print(json.dumps({'nodeId':r['nodeId'],'id':c['Id'],'name':c['Name'].lstrip('/')}))"
    checked=REMOTE.run(('sudo','-n','python3','-c',code),timeout=30)
    if checked.returncode:raise DeploymentError('installation_database_resolution_failed')
    actual=json.loads(checked.stdout)
    if selected not in (actual['id'],actual['name']) or expected and expected!=actual['nodeId']:
        raise DeploymentError('installation_database_identity_conflict')
    result = REMOTE.run((
        'docker', 'exec', actual['id'], 'psql', '--no-psqlrc', '--set=ON_ERROR_STOP=1',
        '--quiet', '--no-align', '--tuples-only', '-U', 'teamaibox', '-d', 'teamaibox',
        '-c', statement,
    ), timeout)
    if result.returncode != 0:
        raise DeploymentError('retained PostgreSQL operation failed')
    return result.stdout.strip()

def snapshot_expression(prefix: str) -> str:
    pieces = []
    for table in HISTORICAL_TABLES:
        pieces.append(
            'SELECT ' + sql_text(table) + ' AS key, count(*)::bigint AS rows, '
            "md5(count(*)::text||':'||"
            "COALESCE(sum((('x'||substr(row_hash,1,16))::bit(64)::bigint)::numeric),0)::text||':'||"
            "COALESCE(sum((('x'||substr(row_hash,17,16))::bit(64)::bigint)::numeric),0)::text||':'||"
            "COALESCE(min(row_hash),'')||':'||COALESCE(max(row_hash),'')) AS anchor "
            f'FROM (SELECT md5(to_jsonb(item)::text) AS row_hash FROM {table} item) hashed'
        )
    union = ' UNION ALL '.join(pieces)
    return (
        'SELECT ' + sql_text(prefix + '|')
        + "||jsonb_object_agg(key,jsonb_build_object('rows',rows,'anchorMd5',anchor) ORDER BY key)::text "
        + 'FROM (' + union + ') snapshot'
    )

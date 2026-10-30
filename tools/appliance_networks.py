#!/usr/bin/env python3
"""Prepare installation-owned Compose networks, preserving attached endpoints."""
import argparse
import ipaddress
import json
from pathlib import Path
from appliance_installation import execute, load, save
from appliance_network_identity import atomic_write

ENV = {'plugin-ingress':'TEAMAIBOX_PLUGIN_INGRESS_NETWORK', 'compute-internal':'TEAMAIBOX_COMPUTE_INTERNAL_NETWORK', 'phone-control':'TEAMAIBOX_PHONE_CONTROL_NETWORK'}


def overlaps(subnet, existing):
    wanted = ipaddress.ip_network(subnet)
    return any(wanted.version == ipaddress.ip_network(n).version and wanted.overlaps(ipaddress.ip_network(n)) for n in existing)


def verify(record, role, spec, actual):
    if actual['Name'] != spec['name'] or actual['Driver'] != 'bridge' or actual['Internal'] != spec['internal']:
        raise ValueError('network_configuration_conflict:' + role)
    if spec.get('id'):
        if actual['Id'] != spec['id']: raise ValueError('network_identity_conflict:' + role)
    else:
        labels = actual.get('Labels') or {}
        if labels.get('com.teamaibox.installation-id') != record['installationId'] or labels.get('com.teamaibox.network-role') != role:
            raise ValueError('foreign_same_name_network:' + role)
    subnets = [v['Subnet'] for v in (actual['IPAM'].get('Config') or []) if v.get('Subnet')]
    if spec.get('subnet') and spec['subnet'] not in subnets:
        raise ValueError('network_subnet_conflict:' + role)
    return {**spec, 'id': actual['Id'], 'subnets':subnets}


def prepare(record, command=execute):
    ids = command(['docker','network','ls','-q','--no-trunc']).split()
    networks = json.loads(command(['docker','network','inspect',*ids])) if ids else []
    routes = json.loads(command(['ip','-j','route','show']))
    route_subnets = [r['dst'] for r in routes if r.get('dst') and r['dst'] != 'default']
    by_name = {n['Name']:n for n in networks}
    created = []; planned = {}
    try:
        for role in ENV:
            spec = record['networks'][role]
            if spec['name'] in by_name:
                planned[role] = verify(record, role, spec, by_name[spec['name']]); continue
            if spec.get('id'): raise ValueError('installed_network_missing:' + role)
            used = route_subnets + [v['Subnet'] for n in networks for v in (n['IPAM'].get('Config') or []) if v.get('Subnet')]
            if spec.get('subnet') and overlaps(spec['subnet'], used): raise ValueError('network_subnet_overlap:' + role)
            args = ['docker','network','create','--driver','bridge','--label','com.teamaibox.installation-id='+record['installationId'], '--label','com.teamaibox.network-role='+role]
            if spec['internal']: args.append('--internal')
            if spec.get('subnet'): args += ['--subnet',spec['subnet']]
            cid = command([*args,spec['name']]).strip(); created.append(cid)
            actual = json.loads(command(['docker','network','inspect',cid]))[0]
            planned[role] = verify(record, role, spec, actual)
            if any(overlaps(n, used) for n in planned[role]['subnets']): raise ValueError('network_allocated_subnet_overlap:' + role)
            networks.append(actual)
    except Exception:
        for cid in reversed(created):
            current = json.loads(command(['docker','network','inspect',cid]))[0]
            if not current.get('Containers') and (current.get('Labels') or {}).get('com.teamaibox.installation-id') == record['installationId']:
                command(['docker','network','rm',cid])
        raise
    return {**record,'networks':planned}


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--installation', required=True); parser.add_argument('--env-output', required=True)
    parser.add_argument('--import-network', action='append', default=[], help='Explicit role=network-ID; preserves existing endpoints')
    args = parser.parse_args(); record=load(args.installation)
    for item in args.import_network:
        role,cid=item.split('=',1)
        if role not in ENV:raise ValueError('network_role_unknown')
        actual=json.loads(execute(['docker','network','inspect',cid]))[0]
        if actual['Id']!=cid:raise ValueError('full_network_id_required')
        spec=dict(name=actual['Name'],id=cid,internal=actual['Internal'])
        existing=record['networks'].get(role)
        if existing and (existing.get('id')!=cid or existing['name']!=spec['name']):raise ValueError('network_import_identity_conflict')
        record['networks'][role]=verify(record,role,spec,actual)
    record=prepare(record);record['references']['networkEnvironment']=str(Path(args.env_output).resolve());save(args.installation,record)
    # Separate additive Compose env file, never overwrite a secret-bearing env.
    lines=[ENV[r]+'='+record['networks'][r]['name'] for r in ENV]
    atomic_write(args.env_output, ('\n'.join(lines)+'\n').encode(),0o600)
    print(json.dumps({'status':'ready','networkIds':{r:s['id'] for r,s in record['networks'].items()}}))


if __name__ == '__main__':main()

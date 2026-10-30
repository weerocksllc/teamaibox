#!/usr/bin/env python3
"""Independent HTTPS identity on first install; existing keys are never replaced."""
import argparse
import json
import os
from pathlib import Path
import secrets
import tempfile
from appliance_installation import execute, host_path, load, resolve, save
from appliance_network_identity import atomic_write


def initialize(directory, web_gid=0):
    directory=Path(directory)
    if not directory.is_absolute() or directory==Path('/') or '..' in directory.parts:raise ValueError('tls_directory_invalid')
    directory.mkdir(parents=True,exist_ok=True,mode=0o750)
    names=('ca.key','ca.crt','web.key','web.crt')
    if any((directory/name).exists() for name in names):
        if not all((directory/name).is_file() and not (directory/name).is_symlink() for name in names):raise ValueError('partial_tls_identity_preserved_requires_recovery')
        execute(['openssl','verify','-CAfile',str(directory/'ca.crt'),str(directory/'web.crt')])
        return {'status':'unchanged','directory':str(directory)}
    with tempfile.TemporaryDirectory(prefix='.new-',dir=directory) as temporary:
        stage=Path(temporary)
        execute(['openssl','req','-x509','-newkey','rsa:3072','-nodes','-sha256','-days','3650','-subj','/CN=Team AI Box '+secrets.token_hex(6),'-keyout',str(stage/'ca.key'),'-out',str(stage/'ca.crt'),'-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign'])
        execute(['openssl','req','-new','-newkey','rsa:2048','-nodes','-subj','/CN=teamaibox.local','-keyout',str(stage/'web.key'),'-out',str(stage/'web.csr')])
        (stage/'extensions').write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:teamaibox.local,DNS:localhost,IP:127.0.0.1\n')
        execute(['openssl','x509','-req','-in',str(stage/'web.csr'),'-CA',str(stage/'ca.crt'),'-CAkey',str(stage/'ca.key'),'-set_serial','0x'+secrets.token_hex(16),'-days','365','-sha256','-extfile',str(stage/'extensions'),'-out',str(stage/'web.crt')])
        for name in names:atomic_write(directory/name,(stage/name).read_bytes(),0o400 if name.endswith('.key') else 0o644)
        os.chown(directory,0,web_gid)
        os.chown(directory/'web.key',0,web_gid);os.chmod(directory/'web.key',0o440)
    return {'status':'initialized','directory':str(directory)}


def configure(installation_file, configuration, dns_names, sfu_config=None):
    record=load(installation_file);web=resolve(record,'web')
    env=dict(v.split('=',1) for v in web['Config']['Env'])
    directory=Path(host_path(web,env['WEB_TLS_CERT_FILE'])).parent
    if host_path(web,env['WEB_TLS_KEY_FILE'])!=str(directory/'web.key'):raise ValueError('web_tls_layout_invalid')
    # Directory mounts are required for atomic certificate replacement.
    if not any(Path(m['Source'])==directory for m in web['Mounts']):raise ValueError('web_tls_directory_mount_required')
    if not all((directory/n).is_file() for n in ('web.key','web.crt','ca.key','ca.crt')):raise ValueError('local_tls_identity_missing')
    old=json.loads(Path(configuration).read_text()) if Path(configuration).exists() else {}
    for key,expected in [('tlsDirectory',str(directory)),('publicStateFile',record['references']['publicAddresses'])]:
        if key in old and old[key]!=expected:raise ValueError('network_identity_reference_conflict:'+key)
    config={**old,'installationFile':str(Path(installation_file).resolve()),'tlsDirectory':str(directory),
            'publicStateFile':record['references']['publicAddresses'],'dnsNames':dns_names or old.get('dnsNames',['teamaibox.local'])}
    config.pop('webContainer',None);config.pop('sfuContainer',None)
    if sfu_config:
        if 'sfu' not in record['services'] or not Path(sfu_config).is_file():raise ValueError('sfu_reference_invalid')
        config['sfuConfig']=str(Path(sfu_config).resolve())
    atomic_write(configuration,(json.dumps(config,indent=2)+'\n').encode(),0o600)
    record['references']['networkIdentity']=str(Path(configuration).resolve());record['references']['httpsIdentity']=str(directory)
    save(installation_file,record)
    return {'status':'configured','existingKeysChanged':False}


def main():
    p=argparse.ArgumentParser();sub=p.add_subparsers(dest='action',required=True)
    init=sub.add_parser('init');init.add_argument('--directory',required=True);init.add_argument('--web-gid',type=int,required=True)
    config=sub.add_parser('configure');config.add_argument('--installation',required=True);config.add_argument('--configuration',required=True);config.add_argument('--dns-name',action='append',default=[]);config.add_argument('--sfu-config')
    args=p.parse_args()
    if os.geteuid()!=0:raise PermissionError('root_required')
    print(json.dumps(initialize(args.directory,args.web_gid) if args.action=='init' else configure(args.installation,args.configuration,args.dns_name,args.sfu_config)))


if __name__=='__main__':main()

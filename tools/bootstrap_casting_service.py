#!/usr/bin/env python3
"""Generate local casting service identities on tmpfs before Docker starts.

No long-lived private key is written to disk. A cold boot creates a new local
trust domain; a service/container restart within that boot reuses the existing
read-only bundle. This never restores sessions or operates on office workers,
displays, routes, disks or Docker. Uses the host's existing OpenSSL only.
"""
import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import subprocess
import sys
import tempfile

from casting_service_credentials import (FILES, GENERATION, DESTINATION, CredentialError,
    exact, require, unique, digest, read_private, secure_directory, require_tmpfs, load_bundle)

PLATFORM_PEER = "spiffe://teamaibox.internal/platform-api"
MEDIA_PEER = "spiffe://teamaibox.local/service/trusted-media/60000000-0000-4000-8000-000000000001"
PRIVATE = tuple(ipaddress.ip_network(value) for value in ("10.0.0.0/8","172.16.0.0/12","192.168.0.0/16"))
PORTS = dict(runtime=19440,callback=19441,publisher=19442,control=19443,viewer=19444,sfu=19450,rtcTcp=19451,rtcUdp=19452)


def validate_plan(plan):
    exact(plan,("schemaVersion","generation","nodeId","nodeGeneration","nodeGroupId","interface",
                "bridgeAddress","platformAddress","lanAddress","protectedSetId"))
    require(type(plan["schemaVersion"]) is int and plan["schemaVersion"]==1 and GENERATION.fullmatch(plan["generation"]))
    for name in ("nodeId","nodeGroupId"):
        require(re.fullmatch(r"[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}",plan[name]))
    require(type(plan["nodeGeneration"]) is int and 1<=plan["nodeGeneration"]<=2**53-1)
    require(re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,14}",plan["interface"]))
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{2,63}",plan["protectedSetId"]))
    addresses=[]
    for name in ("bridgeAddress","platformAddress","lanAddress"):
        address=ipaddress.ip_address(plan[name]);require(address.version==4 and any(address in network for network in PRIVATE))
        require(str(address)==plan[name]);addresses.append(address)
    require(len(set(addresses))==3)
    return plan


def json_bytes(value): return json.dumps(value,separators=(",",":"),sort_keys=True).encode()


def sfu_configuration(plan, key, secret):
    validate_plan(plan)
    require(re.fullmatch(r"cast-[a-f0-9]{32}", key)
            and re.fullmatch(r"[A-Za-z0-9_-]{43,128}", secret))
    # Pin ICE to the appliance LAN. Mapping every Docker bridge candidate to
    # node_ip can send a peer's STUN request to the wrong UDP mux socket.
    # This is an SFU interface filter, not a host route/firewall change.
    return (f"port: {PORTS['sfu']}\nbind_addresses: [127.0.0.1]\nkeys:\n  {key}: {secret}\n"
        f"rtc:\n  node_ip: {plan['lanAddress']}\n  use_external_ip: false\n"
        f"  interfaces:\n    includes: [{plan['interface']}]\n"
        f"  tcp_port: {PORTS['rtcTcp']}\n  udp_port: {PORTS['rtcUdp']}\n"
        "room:\n  auto_create: false\nlogging:\n  level: error\n").encode()


def certificates_valid(destination):
    # Never silently replace credentials mounted by live containers. An
    # expired/soon-expiring boot needs a controlled new service generation;
    # optional casting must not block ordinary office startup.
    for section in ("media","platform"):
        for path in (destination/section).glob("*.crt"):
            result=subprocess.run(["openssl","x509","-in",str(path),"-checkend","86400","-noout"],
                stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,stdin=subprocess.DEVNULL,timeout=5)
            require(result.returncode==0)


def runtime_identity(plan):
    return dict(schemaVersion=1,nodeId=plan["nodeId"],nodeGeneration=plan["nodeGeneration"])


def configurations(plan,pins,contract):
    validate_plan(plan)
    require(set(pins)=={"media-server","platform-server","platform-client","media-client","sfu-server","sfu-client"})
    require(all(re.fullmatch(r"sha256:[0-9a-f]{64}",p) for p in pins.values()))
    # This copy describes actual issued service identities, not an acceptance.
    contract=json.loads(json.dumps(contract))
    require(contract["contractId"]=="teamaibox.trusted-media-callback.v1"
            and contract["serviceIdentity"]["spiffeUri"]==MEDIA_PEER)
    contract["status"]="runtime-bound"
    contract["serviceIdentity"]["certificateFingerprint"]=pins["media-client"]
    contract["activationGate"]={"bound":True,"blockers":[]}
    contract["claimBoundary"]["runtimeBound"]=True
    bridge,platform=plan["bridgeAddress"],plan["platformAddress"]
    def peer(address,port,name,server,client):
        return dict(address=address,port=port,serverName=name,certificateFingerprint=pins[server],
                    certificate=client+".crt",privateKey=client+".key",serverCa="ca.crt")
    runtime=dict(schemaVersion=2,identity=dict(nodeId=plan["nodeId"],nodeGeneration=plan["nodeGeneration"]),
        interface=plan["interface"],listener=dict(address=bridge,port=PORTS["runtime"],certificate="media-server.crt",privateKey="media-server.key",clientCa="ca.crt"),
        callback=peer(platform,PORTS["callback"],"casting.callback.teamaibox.internal","platform-server","media-client"),
        sfu=dict(apiKeyFile="sfu-api-key",apiSecretFile="sfu-api-secret",
            control=peer("127.0.0.1",PORTS["control"],"casting.sfu.teamaibox.internal","sfu-server","sfu-client"),
            publisherEndpoint=f"wss://localhost:{PORTS['publisher']}",viewerEndpoint=f"wss://{bridge}:{PORTS['viewer']}"),hdmi=None)
    gateways=[]
    for role,address in (("publisher","127.0.0.1"),("control","127.0.0.1"),("viewer",bridge)):
        gateways.append(dict(role=role,address=address,port=PORTS[role],certificate="sfu-server.crt",privateKey="sfu-server.key",
            clientCa=None if role=="publisher" else "ca.crt",peerFingerprint=None if role=="publisher" else
            pins["platform-client"] if role=="viewer" else pins["sfu-client"]))
    base="/run/teamaibox/casting"
    env=dict(PLATFORM_CASTING_ACTIVATION_MODE="development",PLATFORM_CASTING_FAILURE_POLICY="isolate",
        PLATFORM_APPLIANCE_NODE_GROUP_ID=plan["nodeGroupId"],
        PLATFORM_CASTING_RUNTIME_IDENTITY_FILE=base+"/runtime-identity.json",PLATFORM_CASTING_CALLBACK_HOST=platform,
        PLATFORM_CASTING_CALLBACK_PORT=str(PORTS["callback"]),PLATFORM_CASTING_CALLBACK_CONTRACT_FILE=base+"/callback-contract.json",
        PLATFORM_CASTING_CALLBACK_CA_FILE=base+"/ca.crt",PLATFORM_CASTING_CALLBACK_CERT_FILE=base+"/platform-server.crt",
        PLATFORM_CASTING_CALLBACK_KEY_FILE=base+"/platform-server.key",
        PLATFORM_TRUSTED_MEDIA_RUNTIME_ORIGIN=f"https://{bridge}:{PORTS['runtime']}",
        PLATFORM_TRUSTED_MEDIA_RUNTIME_SERVER_NAME="casting.media.teamaibox.internal",
        PLATFORM_TRUSTED_MEDIA_RUNTIME_CA_FILE=base+"/ca.crt",PLATFORM_TRUSTED_MEDIA_RUNTIME_CLIENT_CERT_FILE=base+"/platform-client.crt",
        PLATFORM_TRUSTED_MEDIA_RUNTIME_CLIENT_KEY_FILE=base+"/platform-client.key",
        PLATFORM_CASTING_SIGNALLING_ORIGIN=f"https://{bridge}:{PORTS['viewer']}",
        PLATFORM_CASTING_SIGNALLING_SERVER_NAME="casting.sfu.teamaibox.internal",PLATFORM_CASTING_SIGNALLING_CA_FILE=base+"/ca.crt",
        PLATFORM_CASTING_SIGNALLING_CERT_FILE=base+"/platform-client.crt",PLATFORM_CASTING_SIGNALLING_KEY_FILE=base+"/platform-client.key")
    return {"media/runtime.json":json_bytes(runtime),"media/sfu-gateway.json":json_bytes(dict(schemaVersion=1,upstreamPort=PORTS["sfu"],listeners=gateways)),
        "platform/callback-contract.json":json_bytes(contract),"platform/runtime-identity.json":json_bytes(runtime_identity(plan)),
        "platform/platform.env.json":json_bytes(env)}


def bootstrap(plan,contract,*,root=DESTINATION,owner=0,destinations=None):
    validate_plan(plan);require(os.geteuid()==owner)
    root=Path(root);require_tmpfs(root)
    secure_directory(root,uid=owner,private=False)
    destination=root/plan["generation"]
    uids={name:uid for name,(uid,_) in FILES.items()} if destinations is None else destinations
    plan_digest=digest(json_bytes(plan)+json_bytes(contract))
    if destination.exists() or destination.is_symlink():
        secure_directory(destination,uid=owner,private=False)
        raw=read_private(destination/"boot-manifest.json",uid=owner)
        try: manifest=json.loads(raw,object_pairs_hook=unique)
        finally: raw[:]=b"\0"*len(raw)
        exact(manifest,("schemaVersion","configurationDigest","files"))
        require(manifest["schemaVersion"]==1 and manifest["configurationDigest"]==plan_digest)
        require(set(manifest["files"])=={f"{section}/{name}" for section,(_,names) in FILES.items() for name in names})
        require({p.name for p in destination.iterdir()}=={*FILES,"boot-manifest.json"})
        for section,(_,names) in FILES.items():
            secure_directory(destination/section,uid=uids[section])
            require((destination/section).stat().st_mode & 0o777 == 0o500
                    and {p.name for p in (destination/section).iterdir()}==set(names))
            for name in names:
                raw=read_private(destination/section/name,uid=uids[section])
                try:require(digest(raw)==manifest["files"][f"{section}/{name}"]
                    and (destination/section/name).stat().st_mode & 0o777 == 0o400)
                finally:raw[:]=b"\0"*len(raw)
        certificates_valid(destination)
        return {"status":"passed","generation":plan["generation"],"alreadyPresent":True,"sessionRestored":False}
    # All CA private material and CSRs stay under this RAM-only owner directory.
    temporary=Path(tempfile.mkdtemp(prefix=".bootstrap-",dir=root));created=[]
    buffers={}
    try:
        work=temporary/"pki";work.mkdir(mode=0o700)
        def openssl(*args):
            result=subprocess.run(["openssl",*args],cwd=work,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,timeout=15,env={"PATH":"/usr/sbin:/usr/bin:/sbin:/bin","HOME":"/nonexistent","LC_ALL":"C"})
            require(result.returncode==0)
        openssl("req","-x509","-newkey","rsa:2048","-nodes","-days","90","-subj","/CN=Team AI Box boot-local casting CA",
            "-keyout","ca.key","-out","ca.crt","-addext","basicConstraints=critical,CA:TRUE","-addext","keyUsage=critical,keyCertSign,cRLSign")
        certificates=(("media-server","DNS:casting.media.teamaibox.internal","serverAuth"),
            ("platform-server","DNS:casting.callback.teamaibox.internal","serverAuth"),
            ("platform-client","URI:"+PLATFORM_PEER,"clientAuth"),("media-client","URI:"+MEDIA_PEER,"clientAuth"),
            ("sfu-server","DNS:localhost,DNS:casting.sfu.teamaibox.internal","serverAuth"),
            ("sfu-client","URI:spiffe://teamaibox.internal/trusted-media-sfu","clientAuth"))
        pins={}
        for serial,(name,san,usage) in enumerate(certificates,2):
            openssl("req","-new","-newkey","rsa:2048","-nodes","-subj","/CN="+name,"-keyout",name+".key","-out",name+".csr")
            (work/(name+".ext")).write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n"
                f"extendedKeyUsage={usage}\nsubjectAltName={san}\n")
            openssl("x509","-req","-days","90","-in",name+".csr","-CA","ca.crt","-CAkey","ca.key","-set_serial",str(serial),"-extfile",name+".ext","-out",name+".crt")
            pins[name]=digest(ssl.PEM_cert_to_DER_cert((work/(name+".crt")).read_text()))
        buffers.update(configurations(plan,pins,contract))
        key,secret="cast-"+secrets.token_hex(16),secrets.token_urlsafe(48)
        buffers["media/sfu-api-key"]=key.encode();buffers["media/sfu-api-secret"]=secret.encode()
        buffers["sfu/sfu.yaml"]=sfu_configuration(plan,key,secret)
        for section,(_,names) in FILES.items():
            folder=temporary/section;folder.mkdir(mode=0o700);created.append(folder)
            for name in names:
                key=section+"/"+name
                if key not in buffers: buffers[key]=(work/name).read_bytes()
                path=folder/name
                with path.open("xb") as stream:
                    created.append(path)
                    stream.write(buffers[key]);os.fchmod(stream.fileno(),0o400);os.fchown(stream.fileno(),uids[section],uids[section])
            os.chown(folder,uids[section],uids[section]);folder.chmod(0o500)
        manifest=dict(schemaVersion=1,configurationDigest=plan_digest,files={name:digest(raw) for name,raw in buffers.items()})
        path=temporary/"boot-manifest.json";path.write_bytes(json_bytes(manifest));path.chmod(0o400);created.append(path)
        for path in work.iterdir():path.unlink()
        work.rmdir()
        temporary.chmod(0o711)
        require(not destination.exists() and not destination.is_symlink())
        os.rename(temporary,destination);temporary=None
        return {"status":"passed","generation":plan["generation"],"alreadyPresent":False,"sessionRestored":False}
    finally:
        buffers.clear()  # Process exit releases Python/OpenSSL-owned immutable copies.
        if temporary is not None:
            for folder in (temporary/section for section in FILES):
                if folder.is_dir():folder.chmod(0o700)
            for path in reversed(created):
                if path.is_dir():path.rmdir()
                else:path.unlink()
            work=temporary/"pki"
            if work.is_dir():
                for path in work.iterdir():path.unlink()
                work.rmdir()
            temporary.rmdir()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan",required=True);parser.add_argument("--contract",required=True)
    args=parser.parse_args()
    try:
        values=[]
        for name in (args.plan,args.contract):
            path=Path(name);require(path.is_absolute() and path.resolve(strict=True)==path)
            secure_directory(path.parent)
            raw=read_private(path)
            try:values.append(json.loads(raw,object_pairs_hook=unique))
            finally:raw[:]=b"\0"*len(raw)
        print(json.dumps(bootstrap(*values)));return 0
    except Exception:
        print(json.dumps({"status":"failed","failure":"casting_bootstrap_unavailable","sessionRestored":False}));return 1


if __name__=="__main__":sys.exit(main())

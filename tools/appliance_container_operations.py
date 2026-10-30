"""Container maintenance helpers for one installed appliance.

No guest reset, fixed legacy container exclusions, or peer topology is embedded.
Callers must select their exact owned resources before invoking a mutation.
"""
import copy
import json
import os
import time
from appliance_operations import ROOT, run, need, sha
from appliance_target import postgres_target
from appliance_database import remote_psql

MAIN = os.environ.get('TEAMAIBOX_APPLIANCE_SSH')
canonical = lambda value: json.dumps(value, sort_keys=True, separators=(',', ':')).encode()

def sql(query):
    return json.loads(remote_psql(query))

def inspect(host,cid):return json.loads(run(host,['docker','inspect',cid]))[0]
def env(c):return dict(v.split('=',1) for v in c['Config']['Env'])
def healthy(host,cid):return inspect(host,cid)['State'].get('Health',{}).get('Status')=='healthy'
def wait(check,seconds=70):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        if check():return
        time.sleep(2)
    raise RuntimeError('service_readiness_timeout')
def phones():
    return sql("SELECT coalesce(json_agg(x ORDER BY id),'[]') FROM (SELECT p.id,p.owner_id,p.volume_id,p.rom_version_id,p.state,p.generation,p.revision,r.container_id FROM platform.phones p LEFT JOIN platform.phone_runs r ON r.phone_id=p.id AND r.generation=p.generation WHERE p.state<>'deleted')x")
def office(host, *, excluded_ids=()):
    ids = run(host, ['docker', 'ps', '-q', '--no-trunc']).decode().split()
    if not ids:
        return []
    return sorted([dict(id=c['Id'], image=c['Image'], startedAt=c['State']['StartedAt'])
                   for c in json.loads(run(host, ['docker', 'inspect', *ids]))
                   if c['Id'] not in excluded_ids], key=lambda value: value['id'])

# Docker's own create API preserves every unrelated security/resource setting.
# Credentials remain in process memory/stdin, never in the rollout record.
CLONE=r'''import sys,json,socket,http.client
class Docker(http.client.HTTPConnection):
 def connect(self):
  self.sock=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);self.sock.connect('/var/run/docker.sock')
v=json.load(sys.stdin);c=Docker('localhost',timeout=30)
c.request('POST','/v1.47/containers/create?name='+v['name'],json.dumps(v['payload']),{'Content-Type':'application/json'})
r=c.getresponse();b=r.read();assert r.status==201,(r.status,b.decode()[:250]);print(json.loads(b)['Id'])
'''
def clone(host,old,name,environment,mount_source=None):
    cfg=copy.deepcopy(old['Config']);cfg['Hostname']='';cfg['Env']=[k+'='+v for k,v in environment.items()]
    hc=copy.deepcopy(old['HostConfig']);hc['RestartPolicy']={'Name':'unless-stopped','MaximumRetryCount':0}
    if mount_source:
        found=False
        for m in hc.get('Mounts',[]):
            if m['Target']=='/phone-config':m['Source']=mount_source;found=True
        need(found,'phone_config_mount_missing')
    payload={**cfg,'HostConfig':hc}
    if hc['NetworkMode'] not in ('host','none','default') and not hc['NetworkMode'].startswith('container:'):
        payload['NetworkingConfig']={'EndpointsConfig':{n:{'Aliases':[a for a in (v.get('Aliases') or []) if a not in (old['Id'][:12],old['Name'].lstrip('/'))],
            **({'IPAMConfig':copy.deepcopy(v['IPAMConfig'])} if v.get('IPAMConfig') else {})}
            for n,v in old['NetworkSettings']['Networks'].items()}}
    return run(host,['sudo','-n','python3','-c',CLONE],input=json.dumps({'name':name,'payload':payload}).encode()).decode().strip()
def cutover(host,old,cid):
    run(host,['docker','update','--restart=no',old]);run(host,['docker','stop','--time','5',old]);run(host,['docker','start',cid]);wait(lambda:healthy(host,cid))
def rollback(host,old,cid):
    if cid:run(host,['docker','update','--restart=no',cid]);run(host,['docker','stop','--time','5',cid])
    run(host,['docker','update','--restart=unless-stopped',old]);run(host,['docker','start',old]);wait(lambda:healthy(host,old))

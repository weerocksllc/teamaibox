"""Run the real Agent's read-only startup check before an existing Agent stops."""
from copy import deepcopy
import json, subprocess, time
from urllib.parse import quote

def validate_candidate(api, candidate, *, probe_name, expected_image):
    assert candidate['State']['Status']=='created' and candidate['Image']==expected_image
    c,h=deepcopy(candidate['Config']),deepcopy(candidate['HostConfig'])
    c.update(Hostname='',Entrypoint=['/usr/local/bin/teamaibox-node-agent','validate-runtime-startup'],Cmd=[],Healthcheck={'Test':['NONE']})
    h.update(NetworkMode='none',PortBindings={},PublishAllPorts=False,RestartPolicy={'Name':'no'},AutoRemove=False,
        Memory=256*1024**2,MemorySwap=256*1024**2,NanoCpus=0,CpuPeriod=100000,CpuQuota=100000,PidsLimit=128)
    h['Mounts']=[{**m,'ReadOnly':True} for m in h.get('Mounts',[]) if m['Target'] not in ['/var/run/docker.sock','/host/sys','/host/proc']]
    h['Binds']=[];h['Devices']=[];h['DeviceRequests']=[]
    c['HostConfig']=h
    created=api('POST','/containers/create?name='+quote(probe_name,safe=''),c)['Id']
    try:
        api('POST','/containers/'+created+'/start')
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            value=api('GET','/containers/'+created+'/json')
            if value['State']['Status']=='exited':
                assert value['State']['ExitCode']==0,'node_agent_startup_material_check_failed'
                assert not value['State']['OOMKilled']
                return {'status':'passed','candidateContainerId':candidate['Id'],'imageId':expected_image,'probeContainerId':created,'dockerSocketMounted':False,'network':'none','mutationCommandsEnabled':False}
            time.sleep(.2)
        raise RuntimeError('node_agent_startup_material_check_timeout')
    finally:
        value=api('GET','/containers/'+created+'/json')
        assert value['Id']==created and value['Image']==expected_image
        if value['State']['Running']:api('POST','/containers/'+created+'/stop?t=2')
        api('DELETE','/containers/'+created)

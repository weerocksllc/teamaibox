"""Content-free host/cgroup counters; no guest commands or media capture."""
import json

REMOTE = r'''
import datetime as dt,json,os,pathlib,subprocess,sys,time
ids=json.loads(sys.argv[1]);docs=json.loads(subprocess.check_output(['docker','inspect',*ids],timeout=8))
P=pathlib.Path
def pairs(path):
 return {a:int(b) for a,b in (line.split() for line in path.read_text().splitlines())}
def io(path):
 return {line.split()[0]:{a:int(b) for a,b in (v.split('=') for v in line.split()[1:])} for line in path.read_text().splitlines()}
rows=[]
for c in docs:
 pid=c['State']['Pid'];rel=next(x[3:] for x in P('/proc',str(pid),'cgroup').read_text().splitlines() if x.startswith('0::'))
 g=P('/sys/fs/cgroup')/rel.lstrip('/')
 rows.append(dict(id=c['Id'],image=c['Image'],startedAt=c['State']['StartedAt'],running=c['State']['Running'],paused=c['State']['Paused'],
  oomKilled=c['State']['OOMKilled'],cpu=pairs(g/'cpu.stat'),io=io(g/'io.stat'),memoryBytes=int((g/'memory.current').read_text()),
  swapBytes=int((g/'memory.swap.current').read_text()),memoryEvents=pairs(g/'memory.events')))
mem={x.split()[0].rstrip(':'):int(x.split()[1])*1024 for x in P('/proc/meminfo').read_text().splitlines() if len(x.split())==3}
cpu=[int(v) for v in P('/proc/stat').read_text().splitlines()[0].split()[1:9]]
disks={x.split()[2]:[int(v) for v in x.split()[3:]] for x in P('/proc/diskstats').read_text().splitlines()}
paths=set(['/'])
for c in docs:
 paths.update(m['Source'] for m in c['Mounts'] if m['RW'] and m['Destination'] in ('/guest','/phone'))
storage=[]
for path in sorted(paths):
 v=os.statvfs(path);storage.append(dict(path=path,device=os.stat(path).st_dev,totalBytes=v.f_blocks*v.f_frsize,availableBytes=v.f_bavail*v.f_frsize))
try:
 p=subprocess.run(['nvidia-smi','--query-gpu=utilization.gpu,utilization.encoder,utilization.decoder,memory.used,temperature.gpu','--format=csv,noheader,nounits'],capture_output=True,timeout=3)
 gpu=dict(available=p.returncode==0,fields=['gpuPercent','encoderPercent','decoderPercent','memoryMiB','temperatureC'],rows=[x.split(', ') for x in p.stdout.decode().strip().splitlines()] if p.returncode==0 else [],reason=None if p.returncode==0 else 'query_not_supported')
except (OSError,subprocess.TimeoutExpired):gpu=dict(available=False,rows=[],reason='query_unavailable')
print(json.dumps(dict(at=dt.datetime.now(dt.timezone.utc).isoformat(),monotonic=time.monotonic(),cpuCount=os.cpu_count(),cpuTicks=cpu,
 memoryAvailableBytes=mem['MemAvailable'],swapUsedBytes=mem['SwapTotal']-mem['SwapFree'],diskCounters=disks,storage=storage,containers=rows,gpu=gpu)))
'''


def sample(d, ids):
    return json.loads(d.run(d.MAIN, ['sudo', '-n', 'python3', '-c', REMOTE, json.dumps(ids)], timeout=18))


def need(condition, code):
    if not condition:
        raise RuntimeError(code)


def summarize(samples):
    need(len(samples) >= 3, 'resource_samples_missing')
    ids = {r['id'] for r in samples[0]['containers']}
    need(ids and len(ids) == len(samples[0]['containers']), 'duplicate_container')
    rates = []
    for s in samples:
        need({r['id'] for r in s['containers']} == ids and len(s['containers']) == len(ids), 'container_set_changed')
        need(s['memoryAvailableBytes'] >= 16 * 2**30 and s['swapUsedBytes'] == 0, 'host_memory_pressure')
        for r in s['containers']:
            baseline = next(v for v in samples[0]['containers'] if v['id'] == r['id'])
            need(r['running'] and not r['oomKilled'] and r['swapBytes'] == 0
                 and all(r['memoryEvents'].get(k, 0) == baseline['memoryEvents'].get(k, 0)
                         for k in ('oom', 'oom_kill')), 'container_memory_pressure')
    for a, b in zip(samples, samples[1:]):
        elapsed = b['monotonic'] - a['monotonic']
        need(0 < elapsed <= 15, 'resource_sample_gap')
        ticks = [y-x for x, y in zip(a['cpuTicks'], b['cpuTicks'])]
        need(len(ticks) == 8 and min(ticks) >= 0 and sum(ticks) > 0, 'cpu_counter_reset')
        containers = []
        for old in a['containers']:
            new = next(v for v in b['containers'] if v['id'] == old['id'])
            need(all(old[k] == new[k] for k in ('id', 'image', 'startedAt')), 'container_restarted')
            cpu = new['cpu']['usage_usec'] - old['cpu']['usage_usec']
            need(cpu >= 0 and set(old['io']) <= set(new['io']), 'cgroup_counter_reset')
            devices = {}
            for dev in new['io']:
                values = old['io'].get(dev, {})
                delta = {k: new['io'][dev].get(k, 0)-values.get(k, 0) for k in ('rbytes', 'wbytes', 'rios', 'wios')}
                need(min(delta.values()) >= 0, 'io_counter_reset')
                devices[dev] = {k+'PerSecond': v/elapsed for k, v in delta.items()}
            containers.append(dict(id=old['id'], cpuCores=cpu/elapsed/1e6, io=devices))
        rates.append(dict(at=b['at'], seconds=elapsed, hostCpuBusyPercent=100*(sum(ticks)-ticks[3]-ticks[4])/sum(ticks),
                          hostIoWaitPercent=100*ticks[4]/sum(ticks), containers=containers))
    return dict(seconds=samples[-1]['monotonic']-samples[0]['monotonic'], rates=rates,
                minAvailableGiB=min(s['memoryAvailableBytes'] for s in samples)/2**30,
                maxHostCpuBusyPercent=max(r['hostCpuBusyPercent'] for r in rates),
                maxHostIoWaitPercent=max(r['hostIoWaitPercent'] for r in rates),
                maxSwapUsedBytes=max(s['swapUsedBytes'] for s in samples),
                codecCountersAvailable=all(s['gpu']['available'] and s['gpu'].get('rows')
                    and all(len(row)==5 and all(str(v).replace('.', '', 1).isdigit() for v in row[1:3])
                            for row in s['gpu']['rows']) for s in samples),
                hardwareCodecUsedProven=False)

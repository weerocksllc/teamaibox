"""Run real Windows repository tests in a new tmpfs-only PostgreSQL fixture."""
import argparse,datetime as dt,json,os,re,socket,subprocess,time
import appliance_container_operations as d
IMAGE='sha256:8dd950fd4ca6d59e4fc748361bfb059f44907cc99577ae227d196adb29ad8913'
def main():
 p=argparse.ArgumentParser();p.add_argument('--run-id',required=True);a=p.parse_args()
 d.need(re.fullmatch(r'windows-database-tests-\d{8}-a[1-9]\d*',a.run_id),'invalid_run')
 path=d.ROOT/'evidence/validation/components'/(a.run_id+'.json');d.need(not path.exists(),'occupied')
 files=sorted([str(f.relative_to(d.ROOT)) for root in ['packages/persistence/migrations','apps/platform-api/src/virtual-computers'] for f in (d.ROOT/root).iterdir() if f.is_file()]+['apps/platform-api/test/computer-repository-postgres.test.mjs','tools/run_windows_database_tests.py'])
 r=dict(runId=a.run_id,status='failed',scope='isolated-database-only',sources={f:d.sha((d.ROOT/f).read_bytes()) for f in files},startedAt=dt.datetime.now(dt.timezone.utc).isoformat(),image=IMAGE)
 cid=None;tunnel=None
 try:
  cid=d.run(d.MAIN,['docker','run','-d','--name','teamaibox-'+a.run_id,'--label','com.teamaibox.test-run='+a.run_id,
   '--read-only','--memory=512m','--memory-swap=512m','--cpus=1','--tmpfs','/var/lib/postgresql:rw,nosuid,nodev,size=384m',
   '--tmpfs','/var/run/postgresql:rw,nosuid,nodev,size=16m','--tmpfs','/tmp:rw,nosuid,nodev,size=16m',
   '-e','POSTGRES_HOST_AUTH_METHOD=trust','-p','127.0.0.1::5432',IMAGE]).decode().strip()
  r['containerId']=cid
  d.need(re.fullmatch(r'[a-f0-9]{64}',cid),'container_id_invalid')
  c=d.inspect(d.MAIN,cid);d.need(c['Image']==IMAGE and c['HostConfig']['Memory']==512*2**20,'fixture_changed')
  end=time.monotonic()+30
  while True:
   try:d.run(d.MAIN,['docker','exec',cid,'pg_isready','-h','127.0.0.1','-U','postgres'],timeout=5);break
   except Exception:
    if time.monotonic()>end:raise RuntimeError('database_not_ready')
    time.sleep(.5)
  endpoint=d.run(d.MAIN,['docker','port',cid,'5432/tcp']).decode().strip()
  d.need(re.fullmatch(r'127\.0\.0\.1:\d+',endpoint),'not_loopback')
  with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
  tunnel=subprocess.Popen(['ssh','-N','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','ExitOnForwardFailure=yes','-L',f'127.0.0.1:{port}:{endpoint}',d.MAIN],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
  end=time.monotonic()+15
  while True:
   try:
    with socket.create_connection(('127.0.0.1',port),timeout=1):break
   except OSError:
    d.need(tunnel.poll() is None and time.monotonic()<end,'tunnel_failed');time.sleep(.2)
  result=subprocess.run(['node','--test','apps/platform-api/test/computer-repository-postgres.test.mjs'],cwd=d.ROOT,
   env={**os.environ,'TEAMAIBOX_COMPUTER_TEST_PG_PORT':str(port)},capture_output=True,timeout=90)
  r['testOutput']=result.stdout.decode()+result.stderr.decode();r['exitCode']=result.returncode
  d.need(result.returncode==0,'database_tests_failed')
  d.need(all(d.sha((d.ROOT/f).read_bytes())==h for f,h in r['sources'].items()),'source_changed');r['status']='passed'
 except Exception as e:r['failure']=str(e)[-300:]
 finally:
  if tunnel:tunnel.terminate();tunnel.wait(timeout=5)
  if cid:
   c=d.inspect(d.MAIN,cid)
   d.need(c['Image']==IMAGE and c['Config']['Labels']['com.teamaibox.test-run']==a.run_id,'cleanup_identity_changed')
   d.run(d.MAIN,['docker','rm','-f',cid]);r['fixtureRemoved']=True
  r['completedAt']=dt.datetime.now(dt.timezone.utc).isoformat()
  with path.open('x') as f:json.dump(r,f,indent=2)
 print(json.dumps({k:r.get(k) for k in ['runId','status','failure','fixtureRemoved']}));return r['status']!='passed'
if __name__=='__main__':raise SystemExit(main())

"""Bounded control-only outage. The original Agent is always restarted in finally."""
import datetime as dt,json,re,subprocess,sys,time
from pathlib import Path

def now():return dt.datetime.now(dt.timezone.utc).isoformat()
def main():
 cid,image,destination=sys.argv[1:]
 assert re.fullmatch('[a-f0-9]{64}',cid) and re.fullmatch('sha256:[a-f0-9]{64}',image)
 path=Path(destination);assert not path.exists()
 def command(*args):return subprocess.check_output(['docker',*args],timeout=25)
 def inspect():
  value=json.loads(command('inspect',cid))[0];assert value['Image']==image;return value
 result=dict(status='failed',startedAt=now(),containerId=cid,imageId=image)
 inspect();attempted=False
 try:
  attempted=True;command('stop','--time','5',cid);result['stoppedAt']=now()
  assert not inspect()['State']['Running'];time.sleep(80)
 finally:
  if attempted:
   inspect();command('start',cid);result['restartedAt']=now();result['status']='restarted'
  with path.open('x') as f:json.dump(result,f,indent=2)
if __name__=='__main__':main()

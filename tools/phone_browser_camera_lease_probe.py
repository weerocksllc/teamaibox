"""Synthetic input lifetime test with real private sockets and decoder PIDs."""
import io,json,os,select,socket,struct,subprocess,sys,threading,time,uuid
from pathlib import Path
sys.path[:0]=['/opt/teamaibox','/opt/teamaibox/camera-python']
from PIL import Image
from phone_camera_client import control
from phone_camera_input import receive

def main():
    args=json.loads(sys.stdin.readline())
    config={k:str(uuid.uuid4()) for k in ('phoneId','ownerId','runId','volumeId')}
    config.update(version=1,generation=1,buildId='16102939',instance=21)
    Path('/run/phone/config.json').write_text(json.dumps(config))
    directory=Path('/tmp/phone-camera-input');directory.mkdir(mode=0o700)
    children=[];stop=threading.Event();stateLock=threading.Lock();state={'grant':None,'renew':False,'errors':[]}
    def worker_pids():
        found=[]
        for entry in Path('/proc').iterdir():
            if not entry.name.isdecimal():continue
            try:argv=(entry/'cmdline').read_bytes().split(b'\0')
            except (OSError,FileNotFoundError):continue
            if len(argv)>2 and argv[2]==b'/opt/teamaibox/phone_browser_camera_session.py':found.append(int(entry.name))
        return sorted(found)
    def rpc(action,grant,**values):
        with socket.socket(socket.AF_UNIX) as s:
            s.settimeout(12);s.connect(str(directory/'browser.sock'))
            data=json.dumps(dict(action=action,grant=grant,**values)).encode()
            s.sendall(struct.pack('!I',len(data))+data)
            size=struct.unpack('!I',receive(s,4))[0]
            if not 1<=size<=73728:raise RuntimeError('response_too_large')
            value=json.loads(receive(s,size))
            if 'error' in value:raise RuntimeError(value['error'])
            return value['result']
    def open_source():
        grant={k:config[k] for k in ('phoneId','ownerId','runId','generation')}
        grant.update({k:str(uuid.uuid4()) for k in ('id','sourceId','sessionId')});grant['sourceKind']='browser'
        control(dict(action='open',grant=grant,leaseExpiresAt=int(time.time()*1000)+4000))
        with stateLock:state.update(grant=grant,renew=True)
        return grant
    def tick():
        while not stop.wait(.5):
            with stateLock:grant,renew=state['grant'],state['renew']
            if grant and renew:
                try:control(dict(action='renew',grant=grant,leaseExpiresAt=int(time.time()*1000)+4000))
                except Exception:state['errors'].append('renew_failed')
    def frame():
        with socket.socket(socket.AF_UNIX) as s:
            s.settimeout(1);s.connect(str(directory/'frames.sock'));s.sendall(b'F')
            size=struct.unpack('!I',receive(s,4))[0];value=receive(s,size)
        with Image.open(io.BytesIO(value)) as image:
            gray=image.convert('L')
            return dict(width=image.width,height=image.height,points=[gray.getpixel(p) for p in ((160,120),(480,120),(160,360),(480,360))])
    def report(grant):
        memory={k:int((Path('/sys/fs/cgroup')/k).read_text()) for k in ('memory.current','memory.peak','memory.swap.current')}
        memory['events']=dict((a,int(b)) for a,b in (line.split() for line in Path('/sys/fs/cgroup/memory.events').read_text().splitlines()))
        controller=rpc('status',grant) if children[1].poll() is None else {'controlProcessAlive':False}
        return dict(input=control(dict(action='status',grant=grant)),controller=controller,workers=worker_pids(),frame=frame(),memory=memory,errors=list(state['errors']))
    def output(value):print(json.dumps(value),flush=True)
    try:
        for name in ('phone_camera_input.py','phone_browser_camera_control.py'):
            children.append(subprocess.Popen(['/usr/bin/python3','-B','/opt/teamaibox/'+name],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL))
        deadline=time.monotonic()+5
        while not all((directory/f).exists() for f in ('control.sock','frames.sock','browser.sock')):
            if time.monotonic()>deadline or any(c.poll() is not None for c in children):raise RuntimeError('control_start_failed')
            time.sleep(.05)
        threading.Thread(target=tick,daemon=True).start()
        grant=open_source()
        with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
            s.connect((args['peerAddresses'][0],9));bind=s.getsockname()[0]
        output(dict(ready=True,bindAddress=bind,defaultWorkers=worker_pids(),sourceId=grant['sourceId']))
        deadline=time.monotonic()+120
        while time.monotonic()<deadline:
            if not select.select([sys.stdin],[],[],1)[0]:continue
            raw=sys.stdin.readline()
            if not raw:break
            value=json.loads(raw);action=value['action']
            if action=='offer':
                result=rpc('offer',grant,allowedAddresses=args['peerAddresses'],offerSdp=value['sdp'])
                output(result)
            elif action=='status':output(report(grant))
            elif action in ('expire','close','controller-loss'):
                with stateLock:state['renew']=False
                # Let an in-flight .5s renewal finish before the measured cut.
                time.sleep(.6);started=time.monotonic()
                if action=='close':rpc('close',grant)
                if action=='controller-loss':children[1].kill();children[1].wait(2)
                while time.monotonic()-started<6:
                    after=report(grant)
                    if after['input']['state']=='stopped' and not after['workers']:break
                    time.sleep(.1)
                after['elapsedMilliseconds']=round((time.monotonic()-started)*1000,3)
                try:control(dict(action='renew',grant=grant,leaseExpiresAt=int(time.time()*1000)+4000))
                except Exception:after['oldGrantRejected']=True
                else:after['oldGrantRejected']=False
                output(after)
            elif action=='new':
                old=grant;grant=open_source()
                output(dict(sourceId=grant['sourceId'],different=old['sourceId']!=grant['sourceId'],workers=worker_pids()))
            elif action=='finish':
                control(dict(action='close',grant=grant))
                output(dict(final=report(grant),inputServerAlive=children[0].poll() is None,
                            controllerExitCode=children[1].poll()));return 0
            else:raise RuntimeError('command_invalid')
        raise RuntimeError('probe_expired')
    finally:
        stop.set()
        for child in reversed(children):
            if child.poll() is None:child.terminate()
            try:child.wait(2)
            except subprocess.TimeoutExpired:child.kill();child.wait(2)

if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'error':str(error) if str(error).startswith('phone_camera_') else type(error).__name__}),flush=True)
        raise SystemExit(1)

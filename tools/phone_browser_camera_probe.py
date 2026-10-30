"""Synthetic-only receive probe. No Android, physical camera or recording."""
import hashlib,io,json,select,socket,sys,threading,time,uuid,traceback
from pathlib import Path
sys.path[:0]=['/opt/teamaibox','/opt/teamaibox/camera-python']
from PIL import Image
from phone_browser_camera import BrowserCameraReceiver
from phone_camera_input import CameraInput

def main():
    arguments=json.loads(sys.stdin.readline())
    config={k:str(uuid.uuid4()) for k in ('phoneId','ownerId','runId')};config['generation']=1
    grant={**config,**{k:str(uuid.uuid4()) for k in ('id','sourceId','sessionId')},'sourceKind':'browser'}
    state=CameraInput(config,Path('/opt/teamaibox/camera-neutral.jpg').read_bytes())
    state.apply(dict(action='open',grant=grant,leaseExpiresAt=time.time()*1000+4000))
    errors=[];samples=[];stopped=threading.Event()
    local=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);local.connect((arguments['peerAddress'],9));bind=local.getsockname()[0];local.close()
    def deliver(frame,sequence):
        state.apply(dict(action='frame',grant=grant,sequence=sequence),frame)
        if sequence%5==0 and len(samples)<100:
            with Image.open(io.BytesIO(frame)) as image:
                image.load();gray=image.convert('L')
                samples.append(dict(sequence=sequence,at=time.monotonic(),width=image.width,height=image.height,
                    points=[gray.getpixel(x) for x in ((160,120),(480,120),(160,360),(480,360))]))
    receiver=BrowserCameraReceiver(bind_address=bind,first_port=20040,last_port=20049,
        allowed_addresses=set(arguments['peerAddresses']),deliver=deliver,on_failure=errors.append)
    def tick():
        while not stopped.wait(.5):
            state.apply(dict(action='renew',grant=grant,leaseExpiresAt=time.time()*1000+4000));state.expire()
    thread=threading.Thread(target=tick,daemon=True);thread.start()
    def output(value):print(json.dumps(value),flush=True)
    def report():
        root=Path('/sys/fs/cgroup');memory={k:int((root/k).read_text()) for k in ('memory.current','memory.peak','memory.swap.current')}
        memory['events']=dict((a,int(b)) for a,b in (line.split() for line in (root/'memory.events').read_text().splitlines()))
        return dict(status=receiver.status(),errors=errors,samples=samples,memory=memory)
    try:
        output(dict(ready=True,bindAddress=bind));deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            if not select.select([sys.stdin],[],[],1)[0]:continue
            line=sys.stdin.readline()
            if not line:break
            value=json.loads(line)
            if value['action']=='offer':output(dict(answerSdp=receiver.offer(value['sdp'])))
            elif value['action']=='status':output(report())
            elif value['action']=='finish':
                before=report();receiver.close();state.apply(dict(action='close',grant=grant))
                after=state.apply(dict(action='status',grant=grant));output(dict(before=before,after=after,receiverClosed=receiver.status()['state']=='stopped'));return 0
            else:raise RuntimeError('unknown_command')
        raise RuntimeError('probe_expired_or_closed')
    finally:stopped.set();thread.join(2);receiver.close();state.apply(dict(action='close',grant=grant))

if __name__=='__main__':
    try:raise SystemExit(main())
    except Exception as e:
        print(json.dumps(dict(error=str(e) if str(e).startswith('phone_camera_') else type(e).__name__,
            frames=[dict(file=Path(v.filename).name,line=v.lineno,function=v.name) for v in traceback.extract_tb(e.__traceback__)])),flush=True);raise SystemExit(1)

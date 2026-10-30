"""Synthetic MP4 through production client into actual Android Camera2.

No account, physical camera, microphone or media from a user is accessed.
"""
import hashlib
import json
import os
import re
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid


def movie(seconds):
    import gi
    gi.require_version('Gst','1.0')
    from gi.repository import Gst
    Gst.init(None)
    with tempfile.TemporaryDirectory(prefix='synthetic-camera-video-') as directory:
        path=Path(directory)/'test.mp4'
        p=Gst.parse_launch('appsrc name=input format=time ! videoconvert ! video/x-raw,format=I420 ! '
            'openh264enc multi-thread=1 bitrate=300000 ! h264parse ! mp4mux ! filesink location='+str(path))
        source=p.get_by_name('input')
        source.set_property('caps',Gst.Caps.from_string('video/x-raw,format=RGB,width=320,height=240,framerate=15/1'))
        try:
            assert p.set_state(Gst.State.PLAYING)!=Gst.StateChangeReturn.FAILURE
            for i in range(int(seconds*15)):
                # Two known nonblack intensities. Each persists for .73 seconds
                # so a Camera2 sample saved every ten frames sees both phases.
                data=bytes([64 if (i//11)%2==0 else 192])*(320*240*3)
                b=Gst.Buffer.new_allocate(None,len(data),None);b.fill(0,data)
                b.pts=b.dts=i*Gst.SECOND//15;b.duration=Gst.SECOND//15
                assert source.emit('push-buffer',b)==Gst.FlowReturn.OK
            source.emit('end-of-stream')
            event=p.get_bus().timed_pop_filtered(15*Gst.SECOND,Gst.MessageType.EOS|Gst.MessageType.ERROR)
            assert event and event.type==Gst.MessageType.EOS,'synthetic_encode_failed'
        finally:p.set_state(Gst.State.NULL)
        return path.read_bytes()


def main():
    config=json.loads(Path('/run/phone/config.json').read_bytes())
    assert os.getuid()==10001 and config['instance']==21,'synthetic_guest_required'
    sys.path.insert(0,'/opt/teamaibox')
    from phone_camera_client import video_control, control
    result=dict(status='failed',syntheticOnly=True,microphoneUsed=False,cycles=[])
    package='com.teamaibox.phonecameratest'
    adb=['/opt/cuttlefish/bin/adb','-s','127.0.0.1:6540']
    grant=None;active=None;renew_error=[];renew_stop=threading.Event()
    def command(*args):
        p=subprocess.run([*adb,*args],capture_output=True,timeout=12)
        assert p.returncode==0,'guest_command_failed'
        return p.stdout
    def rpc(action,data=None,loop=False,binding=None):
        bound=binding or grant
        request=dict(action=action,grant=bound,deadline=int(time.time()*1000)+14000)
        if action in ('open','renew'):request['leaseExpiresAt']=int(time.time()*1000)+4000
        if data is not None:request.update(sizeBytes=len(data),sha256=hashlib.sha256(data).hexdigest(),loop=loop)
        raw=json.dumps(request).encode()+b'\n'+(data+b'\nTEAMAIBOX-CAMERA-END\n' if data is not None else b'')
        p=subprocess.run(['/usr/bin/python3','-B','/opt/teamaibox/phone_camera_client.py'],input=raw,capture_output=True,timeout=15)
        reply=json.loads(p.stdout)
        assert p.returncode==0 and 'errorCode' not in reply,reply.get('errorCode','client_failed')
        assert all(reply.get(k)==bound[k] for k in bound),'wrong_grant'
        return reply
    def sample():
        try:return json.loads(command('exec-out','run-as',package,'cat','files/sample.json'))
        except (ValueError,AssertionError):return {}
    def renewed():
        while not renew_stop.wait(.8):
            current=active
            if current:
                try:rpc('renew',binding=current)
                except Exception:
                    # EOS races an in-flight renewal and legitimately rejects
                    # it. Do not hide a failure while a source is receiving.
                    try:
                        if rpc('status',binding=current)['state']!='stopped':renew_error.append('renew_failed')
                    except Exception:renew_error.append('renew_unavailable')
    def start(data,loop):
        nonlocal grant,active
        grant={k:config[k] for k in ('phoneId','ownerId','runId','generation')}
        grant.update({k:str(uuid.uuid4()) for k in ('id','sessionId','sourceId')},sourceKind='video')
        rpc('open');active=grant
        at=time.monotonic();state=rpc('video',data,loop)
        assert state['state']=='receiving','first_frame_not_received'
        return at
    def observe(seconds):
        at=time.monotonic();rows=[];last=-1
        while time.monotonic()-at<seconds:
            s=sample()
            assert not s.get('error'),s.get('error')
            if s.get('previewFrames',0)>last and s.get('previewY'):
                last=s['previewFrames'];rows.append(dict(seconds=round(time.monotonic()-at,3),frames=last,y=s['previewY'],width=s['width'],height=s['height']))
            time.sleep(.1)
        phases=[0 if sum(x['y'])/4<110 else 1 for x in rows if min(x['y'])>30]
        changes=sum(a!=b for a,b in zip(phases,phases[1:]))
        assert len(rows)>=6 and set(phases)=={0,1} and changes>=3,'android_dynamic_video_missing'
        assert all(x['width']==640 and x['height']==480 for x in rows),'android_camera_size_changed'
        return dict(samples=rows,phaseChanges=changes)
    def neutral(at):
        before=sample().get('previewFrames',0)
        while time.monotonic()-at<6:
            value=sample();state=rpc('status')
            worker=video_control({'action':'status','grant':grant})
            if value.get('previewFrames',0)>before and max(value.get('previewY',[255]))<30 and state['state']=='stopped' and not worker['workerRunning']:
                # Public status deliberately omits internal counters. Inspect
                # retained bytes through the existing private broker socket.
                assert control({'action':'status','grant':grant})['retainedFrameBytes']==0,'video_frame_retained'
                return dict(seconds=round(time.monotonic()-at,3),beforeFrames=before,afterFrames=value['previewFrames'],previewY=value['previewY'],retainedFrameBytes=0,workerStopped=True)
            time.sleep(.1)
        raise AssertionError('android_video_clear_failed')
    thread=threading.Thread(target=renewed,daemon=True);thread.start()
    try:
        long=movie(9);short=movie(1.6)
        result['fixtures']=[dict(sha256=hashlib.sha256(x).hexdigest(),bytes=len(x)) for x in (long,short)]
        command('shell','am','force-stop',package)
        command('exec-out','run-as',package,'rm','-f','files/sample.json','files/sample.pending')
        command('shell','am','start','-W','-n',package+'/.MainActivity')
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            current=sample()
            if current.get('previewFrames',0)>=30 and max(current.get('previewY',[255]))<30:break
            time.sleep(.15)
        assert current.get('previewFrames',0)>=30 and max(current['previewY'])<30,'initial_camera_not_neutral'
        result['initial']=current
        at=start(long,False);observed=observe(6)
        # Source must end on its own even though permission is still renewed.
        deadline=at+12
        while time.monotonic()<deadline and rpc('status')['state']!='stopped':time.sleep(.1)
        active=None
        result['cycles'].append(dict(kind='ended',loop=False,elapsedSeconds=round(time.monotonic()-at,3),**observed))
        result['cycles'][-1]['clear']=neutral(time.monotonic())
        at=start(short,True);observed=observe(6)
        assert rpc('status')['state']=='receiving','loop_did_not_continue'
        active=None;stop=time.monotonic();rpc('close')
        result['cycles'].append(dict(kind='loop-stop',loop=True,elapsedSeconds=round(stop-at,3),**observed,clear=neutral(stop)))
        start(short,True);observe(5)
        workers=[]
        for path in Path('/proc').glob('[0-9]*/cmdline'):
            try:
                args=path.read_bytes().split(b'\0')
                if b'/opt/teamaibox/phone_video_camera_worker.py' in args and path.stat().st_uid==10001:workers.append(int(path.parent.name))
            except (FileNotFoundError,PermissionError):pass
        assert len(workers)==1,'decoder_identity_ambiguous'
        active=None;at=time.monotonic();os.kill(workers[0],signal.SIGKILL)
        result['cycles'].append(dict(kind='decoder-killed',clear=neutral(at)))
        start(short,True);observe(5);active=None;at=time.monotonic()
        result['cycles'].append(dict(kind='lease-expired',clear=neutral(at)))
        assert not renew_error,'video_renew_failed'
        result.update(status='passed',jpegCaptured=bool(sample().get('jpegCaptured')),output=[640,480],audioForwarded=False)
    except Exception as error:
        result['failure']=str(error) if isinstance(error,(RuntimeError,AssertionError)) else type(error).__name__
        if isinstance(error,KeyError):result['missingTestField']=str(error)[:100]
    finally:
        active=None;renew_stop.set();thread.join(3)
        if grant:
            try:rpc('close')
            except Exception:pass
        try:
            command('shell','am','force-stop',package)
            process=subprocess.run([*adb,'shell','pidof',package],capture_output=True,timeout=5)
            assert process.returncode in (0,1),'process_check_failed'
            result['fixtureProcessStopped']=not process.stdout.strip()
            dump=subprocess.run([*adb,'shell','dumpsys','-t','3','media.camera'],capture_output=True,timeout=6)
            text=dump.stdout.decode(errors='replace')
            result['cameraCloseDiagnostic']=dict(dumpExitCode=dump.returncode,
                activeClientsEmpty=bool(re.search(r'Active Camera Clients:\s*\[\s*\]',text)),
                dumpTimedOut='timed out' in text.lower())
            assert dump.returncode==0 and result['cameraCloseDiagnostic']['activeClientsEmpty'],'camera_client_retained'
            assert result['fixtureProcessStopped'],'camera_fixture_running'
            result['appStopped']=True
        except Exception as error:
            result.update(status='failed',appStopped=False,
                closeFailure=str(error) if isinstance(error,(AssertionError,RuntimeError)) else type(error).__name__)
    print(json.dumps(result));return result['status']!='passed'


if __name__=='__main__':raise SystemExit(main())

"""Real Camera2 preview/photo, source revocation and reopening; public patterns only."""
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import time
import uuid


def main():
    config=json.loads(Path('/run/phone/config.json').read_bytes())
    assert os.getuid()==10001 and config['instance']==21,'synthetic_instance_required'
    package='com.teamaibox.phonecameratest';adb=['/opt/cuttlefish/bin/adb','-s','127.0.0.1:6540']
    result=dict(status='failed',syntheticOnly=True,microphoneUsed=False,transport='request-mjpeg-vhost-user-media',cycles=[])
    source=Path('/opt/teamaibox/camera-checker.jpg').read_bytes()
    grant={k:config[k] for k in ('phoneId','ownerId','runId','generation')}
    grant.update({k:str(uuid.uuid4()) for k in ('id','sessionId','sourceId')});grant['sourceKind']='image'
    active=None;last_grant=grant
    def command(*args):
        r=subprocess.run([*adb,*args],capture_output=True,timeout=12)
        if r.returncode:raise RuntimeError('camera_guest_command_failed')
        return r.stdout
    def receive(s,n):
        value=b''
        while len(value)<n:
            block=s.recv(n-len(value))
            if not block:raise RuntimeError('camera_control_disconnected')
            value+=block
        return value
    def rpc(action,binding=None,frame=None,expect_error=None):
        request=dict(action=action,grant=binding or last_grant)
        if action in ('open','renew'):request['leaseExpiresAt']=(time.time()+4)*1000
        if action=='frame':request['sequence']=1
        raw=json.dumps(request).encode()
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
            s.settimeout(2);s.connect('/tmp/phone-camera-input/control.sock');s.sendall(struct.pack('!I',len(raw))+raw)
            if frame is not None:s.sendall(struct.pack('!I',len(frame))+frame)
            length=struct.unpack('!I',receive(s,4))[0];assert 0<length<4096,'camera_control_reply_large'
            reply=json.loads(receive(s,length))
        if expect_error:
            assert reply.get('error')==expect_error,'camera_negative_not_rejected';return
        if reply.get('error'):raise RuntimeError(reply['error'])
        return reply['result']
    def sample():
        try:return json.loads(command('exec-out','run-as',package,'cat','files/sample.json'))
        except (RuntimeError,ValueError):return {}
    def close_app():
        command('shell','am','force-stop',package);start=time.monotonic()
        text=command('shell','dumpsys','-t','3','media.camera').decode(errors='replace')
        assert 'DUMP TIMEOUT' not in text and 'Active Camera Clients:\n[]' in text,'camera_close_not_ready'
        return round(time.monotonic()-start,3)
    try:
        assert b'Success' in command('install','/opt/teamaibox/test-camera.apk'),'fixture_install_failed'
        command('shell','pm','grant',package,'android.permission.CAMERA')
        # A new disposable guest can still be on its lock screen. Keep normal
        # foreground-camera policy; unlock it like the media acceptance does.
        command('shell','input','keyevent','KEYCODE_WAKEUP')
        command('shell','wm','dismiss-keyguard')
        result['testGuestUnlocked']=True
        command('logcat','-c')
        result['guestVideoDevices']=command('shell','ls','/sys/class/video4linux').decode().splitlines()
        result['providerApex']=command('shell','getprop','ro.boot.vendor.apex.com.google.emulated.camera.provider.hal').decode().strip()
        bad={**grant,'ownerId':str(uuid.uuid4())}
        rpc('open',bad,expect_error='phone_camera_stale_run');result['otherOwnerRejected']=True
        for cycle in range(3):
            if cycle!=1:
                if cycle==2:
                    old=last_grant;last_grant={**grant,'id':str(uuid.uuid4()),'sourceId':str(uuid.uuid4())}
                    rpc('renew',old,expect_error='phone_camera_lease_revoked');result['oldSourceRejected']=True
                rpc('open');rpc('frame',frame=source);active=last_grant
            command('shell','am','force-stop',package)
            command('exec-out','run-as',package,'rm','-f','files/sample.json','files/sample.pending')
            command('shell','am','start','-W','-n',package+'/.MainActivity')
            started=time.monotonic();deadline=started+20;current={};next_renew=0
            while time.monotonic()<deadline:
                if active and time.monotonic()>=next_renew:rpc('renew',active);next_renew=time.monotonic()+1
                current=sample()
                if current.get('error'):raise RuntimeError(current['error'])
                if current.get('jpegCaptured') and current.get('previewFrames',0)>=30:break
                time.sleep(.12)
            assert current.get('jpegCaptured') and current.get('previewFrames',0)>=30,'camera_cycle_incomplete'
            expected=[0,0,0,0] if cycle==1 else [0,255,255,0]
            for key in ('previewY','photoRgb'):
                assert all(abs(a-b)<=30 for a,b in zip(current[key],expected)),'camera_cycle_pattern_wrong'
            entry=dict(cycle=cycle+1,kind='neutral' if cycle==1 else 'image',guest=current,seconds=round(time.monotonic()-started,3))
            result['cycles'].append(entry)
            if cycle==0:
                at=time.monotonic();rpc('close',active);active=None
                before=current['previewFrames']
                while time.monotonic()-at<8:
                    value=sample()
                    if value.get('previewFrames',0)>before and max(value.get('previewY',[255]))<30:break
                    time.sleep(.12)
                assert value.get('previewFrames',0)>before and max(value.get('previewY',[255]))<30,'camera_revoke_did_not_clear'
                result['revokedPreviewAfterSeconds']=round(time.monotonic()-at,3)
            if cycle==2:
                # No close or renew: the independently enforced lease expires.
                at=time.monotonic();before=current['previewFrames']
                while time.monotonic()-at<7:
                    value=sample()
                    if value.get('previewFrames',0)>before and max(value.get('previewY',[255]))<30:break
                    time.sleep(.12)
                result['expiryObservation']={'beforeFrames':before,'afterFrames':value.get('previewFrames'),
                    'previewY':value.get('previewY'),'error':value.get('error'),'source':rpc('status')}
                assert value.get('previewFrames',0)>before and max(value.get('previewY',[255]))<30,'camera_expiry_did_not_clear'
                result['expiredPreviewAfterSeconds']=round(time.monotonic()-at,3)
                state=rpc('status');assert state['state']=='stopped' and state['retainedFrameBytes']==0,'camera_private_frame_retained'
                result['expiredFrameBytes']=state['retainedFrameBytes'];active=None
            entry['closeSeconds']=close_app()
        if active:rpc('close',active);active=None
        result.update(guest=result['cycles'][-1]['guest'],framesDelivered=rpc('status')['framesDelivered'],appStopped=True,status='passed')
    except Exception as error:
        result['failure']=str(error) if isinstance(error,(RuntimeError,AssertionError)) else type(error).__name__
        try:
            # Collect the bounded camera errors BEFORE app closure adds noise.
            lines=command('logcat','-d','-v','brief','*:E').decode(errors='replace').splitlines()
            result['failureCameraLog']=[x[:500] for x in lines if any(w in x.lower() for w in ('camera','v4l2','buffer','fence','dequeue','frame'))][-40:]
            result['testGuestForeground']=[x.strip()[:350] for x in command('shell','dumpsys','activity','activities').decode(errors='replace').splitlines() if any(k in x for k in ('topResumedActivity','mResumedActivity','mKeyguardShowing','mKeyguardGoingAway'))][-8:]
        except Exception:pass
    finally:
        try:
            if active:rpc('close',active)
            result['finalCloseSeconds']=close_app();result['appStopped']=True
        except Exception as error:
            result.update(status='failed',appStopped=False,closeFailure=str(error) if isinstance(error,(RuntimeError,AssertionError)) else type(error).__name__)
        for name in ('backend.log','input.log'):
            p=Path('/tmp/phone-camera-input')/name
            if p.exists():
                with p.open('rb') as f:f.seek(max(0,p.stat().st_size-1800));result[name]=f.read(1800).decode(errors='replace')
        if result['status']!='passed':
            try:
                lines=command('logcat','-d','-t','500').decode(errors='replace').splitlines()
                result['cameraErrors']=[x[:350] for x in lines if any(w in x.lower() for w in ('camera','v4l2')) and any(w in x.lower() for w in ('error','fail','invalid','timeout'))][-15:]
            except Exception:pass
    print(json.dumps(result));return result['status']!='passed'


if __name__=='__main__':raise SystemExit(main())

#!/usr/bin/python3
"""Synthetic-only Camera2 test inside its new phone, using standard vsock frames."""
import json,os,select,socket,struct,subprocess,time
from pathlib import Path

def main():
    cfg=json.loads(Path('/run/phone/config.json').read_bytes())
    assert os.getuid()==10001 and cfg['instance']==21,'synthetic_instance_required'
    adb=['/opt/cuttlefish/bin/adb','-s','127.0.0.1:6540']
    def command(*args):
        p=subprocess.run([*adb,*args],capture_output=True,timeout=12)
        if p.returncode:raise RuntimeError('guest_command_failed')
        return p.stdout
    package='com.teamaibox.phonecameratest'
    result={'status':'failed','syntheticOnly':True,'microphoneUsed':False,'events':[],'framesSent':0}
    s=None;step='install'
    try:
        assert b'Success' in command('install','/opt/teamaibox/test-camera.apk'),'install_failed'
        command('shell','pm','grant',package,'android.permission.CAMERA')
        command('shell','am','start','-W','-n',package+'/.MainActivity')
        result['guestCameraPort']=command('shell','getprop','ro.boot.vsock_camera_port').decode().strip()
        result['guestCameraProviders']=[name for name in command('shell','ls','/vendor/bin/hw').decode().splitlines() if 'camera' in name.lower()]
        result['guestCameraService']=command('shell','dumpsys','media.camera').decode(errors='replace').splitlines()[:24]
        step='camera_transport'
        cvd=json.loads(Path('/phone/cuttlefish/assembly/cuttlefish_config.json').read_bytes())
        instance=cvd['instances'][str(cfg['instance'])]
        result['cameraConfiguration']={k:v for k,v in instance.items() if k in ('camera_server_port','vsock_guest_cid','vhost_user_vsock')}
        cid=2100+cfg['instance'];assert instance['camera_server_port']==7600 and instance['vsock_guest_cid']==cid,'camera_configuration_mismatch'
        # Current Cuttlefish may use its per-phone Unix/vhost-user transport,
        # not the host kernel AF_VSOCK endpoint. Follow the actual config.
        vhost=instance['vhost_user_vsock'];assert type(vhost) is bool,'unknown_camera_transport'
        result['transport']='vhost-user' if vhost else 'kernel-vsock'
        s=socket.socket(socket.AF_UNIX if vhost else socket.AF_VSOCK,socket.SOCK_STREAM);s.settimeout(3)
        if vhost:
            s.connect('/tmp/vsock_'+str(cid)+'_10001/vm.vsock');s.sendall(b'connect 7600\n')
            expected=b'OK 7600\n';reply=b''
            while len(reply)<len(expected):
                part=s.recv(len(expected)-len(reply))
                if not part:raise RuntimeError('vhost_camera_closed')
                reply+=part
            assert reply==expected,'vhost_camera_handshake_failed'
        else:s.connect((cid,7600))
        step='camera_frames'
        def send(raw):s.sendall(struct.pack('<i',len(raw))+raw)
        def receive():
            def exact(n):
                raw=b''
                while len(raw)<n:
                    data=s.recv(n-len(raw))
                    if not data:raise RuntimeError('camera_transport_closed')
                    raw+=data
                return raw
            length=struct.unpack('<i',exact(4))[0]
            if not 0<length<=4096:raise RuntimeError('camera_event_invalid')
            return json.loads(exact(length))
        send(json.dumps(dict(command='camera_settings',width=640,height=480,frame_rate=15.0,facing='environment')).encode())
        y=b''.join((bytes([16])*320+bytes([235])*320) if row<240 else (bytes([235])*320+bytes([16])*320) for row in range(480))
        frame=y+bytes([128])*(640*480//2)
        end=time.monotonic()+65;active=False;next_frame=time.monotonic();next_sample=0
        while time.monotonic()<end:
            now=time.monotonic()
            if select.select([s],[],[],max(0,min(.05,next_frame-now)))[0]:
                event=receive().get('event');result['events'].append(event)
                if event=='VIRTUAL_DEVICE_START_CAMERA_SESSION':active=True
                elif event=='VIRTUAL_DEVICE_STOP_CAMERA_SESSION':active=False
                elif event=='VIRTUAL_DEVICE_CAPTURE_IMAGE':
                    jpeg=command('exec-out','run-as',package,'cat','files/source.jpg')
                    assert jpeg[:2]==b'\xff\xd8' and len(jpeg)<1024**2,'fixture_jpeg_invalid'
                    send(jpeg);result['jpegSuppliedBytes']=len(jpeg)
            now=time.monotonic()
            if active and now>=next_frame:
                send(frame);result['framesSent']+=1;next_frame=now+1/15
            elif not active:next_frame=now+.05
            if now>=next_sample:
                next_sample=now+1
                try:sample=json.loads(command('exec-out','run-as',package,'cat','files/sample.json'))
                except (ValueError,RuntimeError):continue
                result['guest']=sample
                if sample.get('error'):raise RuntimeError(sample['error'])
                if sample.get('jpegCaptured'):break
        sample=result.get('guest',{})
        assert sample.get('previewFrames',0)>=30 and sample.get('width')==640 and sample.get('height')==480,'preview_not_observed'
        assert sample.get('jpegCaptured') and sample.get('jpegWidth')==640 and sample.get('jpegHeight')==480,'photo_not_observed'
        assert len(sample.get('previewY',[]))==len(sample.get('photoRgb',[]))==4,'missing_pixel_results'
        for field in ('previewY','photoRgb'):
            a,b,c,d=sample[field];assert a<40 and b>210 and c>210 and d<40,'guest_pattern_mismatch'
        result['status']='passed'
    except Exception as e:
        result['failure']=str(e) if isinstance(e,(AssertionError,RuntimeError)) else type(e).__name__
        result['failureStep']=step
        if isinstance(e,OSError):result['errno']=e.errno
    finally:
        if s:s.close()
        try:command('shell','am','force-stop',package);result['appStopped']=True
        except Exception:result['appStopped']=False;result['status']='failed'
    print(json.dumps(result));return 0 if result['status']=='passed' else 1
if __name__=='__main__':raise SystemExit(main())

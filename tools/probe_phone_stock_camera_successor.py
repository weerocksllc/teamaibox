#!/usr/bin/python3
"""Two fresh stock-Camera2 opens, synthetic circle only, no saved frames."""
import hashlib,io,json,os,subprocess,sys,time,uuid,re,xml.etree.ElementTree as ET
from pathlib import Path
sys.path[:0]=['/opt/teamaibox','/opt/teamaibox/camera-python']
from PIL import Image,ImageDraw
from phone_camera_client import control

def validate_test_identity(config,rid):
    assert re.fullmatch(r'phone-camera-(?:video-hal|lifecycle-(?:google|standard))-\d{8}-a[1-9]\d*',rid),'unexpected_test_run'
    assert config['phoneId']==str(uuid.uuid5(uuid.NAMESPACE_URL,rid+':phoneId')),'unexpected_test_phone'
    assert config['runId']==str(uuid.uuid5(uuid.NAMESPACE_URL,rid+':run')),'unexpected_test_runtime'
    assert config['instance']==21,'unexpected_test_instance'

def controls(cmd):
    path='/data/local/tmp/phone-stock-camera.xml'
    cmd('shell','uiautomator','dump',path)
    try:return ET.fromstring(cmd('exec-out','cat',path).decode())
    finally:cmd('shell','rm',path)

def dismiss_location_intro(cmd):
    # First-launch stock Camera2 asks about geotagging before showing preview.
    # Exercise that normal UI in this disposable guest; never grant location,
    # change the product default, or skip the subsequent preview measurement.
    root=controls(cmd)
    nodes={n.get('resource-id'):n for n in root.iter('node')}
    box=nodes.get('com.android.camera2:id/check_box')
    button=nodes.get('com.android.camera2:id/confirm_button')
    if box is None or button is None:return False
    assert any(n.get('text')=='Remember photo locations?' for n in root.iter('node')),'unknown_camera_intro'
    def tap(node):
        nums=[int(v) for v in re.findall(r'\d+',node.get('bounds',''))]
        assert len(nums)==4 and node.get('clickable')=='true','invalid_intro_control'
        # Camera2's immersive dialog extends beneath Android's transient
        # navigation bar. Its upper quarter remains inside the button and
        # avoids sending a Home tap through the overlaid bottom controls.
        y=nums[1]+(nums[3]-nums[1])//4 if node.get('resource-id')=='com.android.camera2:id/confirm_button' else (nums[1]+nums[3])//2
        cmd('shell','input','tap',str((nums[0]+nums[2])//2),str(y))
    if box.get('checked')=='true':
        tap(box)
        nodes={n.get('resource-id'):n for n in controls(cmd).iter('node')}
        box=nodes.get('com.android.camera2:id/check_box')
        button=nodes.get('com.android.camera2:id/confirm_button')
        assert box is not None and box.get('checked')=='false' and button is not None,'location_not_declined'
    tap(button)
    return True

def main():
    c=json.loads(Path('/run/phone/config.json').read_bytes())
    mount=next(l for l in Path('/proc/self/mountinfo').read_text().splitlines() if ' /run/phone-test ' in l)
    rid=mount.split()[3].split('/')[-1]
    assert os.getuid()==10001,'unexpected_test_uid'
    validate_test_identity(c,rid)
    adb=['/opt/cuttlefish/bin/adb','-s','127.0.0.1:6540']
    def cmd(*args):return subprocess.check_output(adb+list(args),stderr=subprocess.DEVNULL,timeout=20)
    package='com.android.camera2';expected='359cc77e058cc9324903d4fdbca7b0ed972e8fdca03acf0163ba6eba46df6090'
    path=cmd('shell','pm','path',package).decode().strip()
    assert path=='package:/product/app/Camera2/Camera2.apk','not_clean_system_camera'
    assert cmd('shell','sha256sum',path[8:]).decode().split()[0]==expected,'wrong_stock_camera'
    assert cmd('shell','getenforce').strip()==b'Enforcing','selinux_changed'
    # Permission is granted only in this disposable synthetic guest. No
    # physical camera, microphone, Google account or member volume is present.
    cmd('shell','pm','grant',package,'android.permission.CAMERA')
    cmd('shell','pm','grant',package,'android.permission.RECORD_AUDIO')
    result=dict(status='failed',syntheticOnly=True,framesRecorded=False,microphoneUsed=False,
        cleanSystemApp=True,apkSha256=expected,cycles=[])
    grant=None
    try:
        for cycle in range(2):
            cmd('shell','am','force-stop','com.teamaibox.phonecameratest')
            cmd('shell','am','force-stop','com.teamaibox.camerageometry')
            cmd('shell','am','force-stop',package)
            grant={k:c[k] for k in ('phoneId','ownerId','runId','generation')}
            grant.update({k:str(uuid.uuid4()) for k in ('id','sourceId','sessionId')},sourceKind='video')
            cmd('shell','input','keyevent','KEYCODE_WAKEUP')
            cmd('shell','wm','dismiss-keyguard')
            launch=cmd('shell','am','start','-W','-a','android.media.action.STILL_IMAGE_CAMERA')
            assert b'Status: ok' in launch,'stock_launch_failed'
            if dismiss_location_intro(cmd):result['firstLaunchLocationDeclined']=True
            control(dict(action='open',grant=grant,leaseExpiresAt=time.time()*1000+4000))
            im=Image.new('RGB',(640,480),(40,40,40));draw=ImageDraw.Draw(im)
            draw.ellipse((360,130,600,370),fill=(40,180,90),outline='white',width=5)
            buf=io.BytesIO();im.save(buf,format='JPEG',quality=90);data=buf.getvalue()
            start=time.monotonic()
            for seq in range(180):
                if seq%15==0:control(dict(action='renew',grant=grant,leaseExpiresAt=time.time()*1000+4000))
                control(dict(action='frame',grant=grant,sequence=seq),data)
                time.sleep(max(0,start+(seq+1)/15-time.monotonic()))
            screen=Image.open(io.BytesIO(cmd('exec-out','screencap','-p'))).convert('RGB')
            points=[(i%screen.width,i//screen.width) for i,(r,g,b) in enumerate(screen.getdata()) if 20<r<85 and 140<g<215 and 45<b<135]
            if len(points)<=10000:
                # This guest has no member data. Preserve only the camera's
                # startup controls/error classes, never screenshots or pixels.
                result['circlePixels']=len(points)
                logs=cmd('shell','logcat','-d','-b','crash').decode(errors='replace')
                result['cameraErrors']=[l[:250] for l in logs.splitlines() if any(v in l for v in ('Exception','FATAL','Caused by:','at com.android.camera'))][-15:]
                logs=cmd('shell','logcat','-d','-t','1000').decode(errors='replace')
                result['cameraLifecycle']=[l[:350] for l in logs.splitlines() if any(v in l for v in ('CAM_', 'com.android.camera2','ExternalCameraDevice','Fatal signal'))][-35:]
                focus=cmd('shell','dumpsys','window').decode(errors='replace')
                result['focus']=[l.strip()[:200] for l in focus.splitlines() if 'mCurrentFocus' in l or 'mFocusedApp' in l]
                activity=cmd('shell','dumpsys','activity','activities').decode(errors='replace')
                result['activity']=[l.strip()[:200] for l in activity.splitlines() if any(s in l for s in ('mResumedActivity','topResumedActivity','mLastPausedActivity','Hist #0'))][-8:]
                root=controls(cmd)
                result['startupControls']=[{k:n.get(k) for k in ('package','resource-id','text','clickable','bounds')}
                    for n in root.iter('node') if n.get('text')][:30]
                raise AssertionError('synthetic_circle_missing')
            w=max(p[0] for p in points)-min(p[0] for p in points)+1
            h=max(p[1] for p in points)-min(p[1] for p in points)+1
            measured=dict(width=w,height=h,ratio=w/h,filledFraction=len(points)/(w*h))
            del screen,points
            assert .98<=w/h<=1.02 and .70<measured['filledFraction']<.85,'stock_preview_distorted'
            closed=control(dict(action='close',grant=grant))
            # Close is an acknowledgement; retained-byte counters belong to
            # the broker's status response, not the close response.
            status=control(dict(action='status',grant=grant));grant=None
            assert closed['state']==status['state']=='stopped' and status['retainedFrameBytes']==0,'frame_retained'
            cmd('shell','am','force-stop',package)
            result['cycles'].append(dict(cycle=cycle+1,sourceFrames=180,circle=measured,sourceClosed=True))
        result['status']='passed'
    except Exception as e:
        result['failure']=str(e)[:200] if isinstance(e,(AssertionError,RuntimeError)) else type(e).__name__
    finally:
        if grant:control(dict(action='close',grant=grant))
        cmd('shell','am','force-stop',package)
    print(json.dumps(result))

if __name__=='__main__':main()

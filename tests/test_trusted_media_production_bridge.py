"""Real, isolated Gst -> LiveKit -> Gst audio/video component test.

Run only in the exact ARM64 GDP/WebRTC image sharing the network namespace of
an isolated, no-network SFU test container. Synthetic patterns and tones only.
No Apple sender, HDMI, system-browser or deployed authorization claim.
"""
import hashlib
import hmac
import http.client
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import socket
import socketserver
import ssl
import struct
import subprocess
import tempfile
import threading
import time
import unittest
from uuid import uuid4

from services.trusted_media_service.publisher_credentials import PublisherCredentialIssuer
from services.trusted_media_service.viewer_token_issuer import _b64

SECRET = "synthetic-only-not-a-deployment-livekit-secret"
KEY = "room-test-key"


class TlsRelay(socketserver.BaseRequestHandler):
    def handle(self):
        started=time.monotonic()
        try:
            self.request.settimeout(3)
            with self.server.tls.wrap_socket(self.request, server_side=True) as channel:
                with socket.create_connection(("127.0.0.1", 7880), timeout=3) as upstream:
                    self.server.tls_versions.add(channel.version())
                    # Transparent private TLS relay, no request/token logging.
                    deadline = time.monotonic()+120
                    while time.monotonic()<deadline and not self.server.done.is_set():
                        ready, _, _ = select.select([channel, upstream], [], [], 0.05)
                        if channel.pending() and channel not in ready: ready.append(channel)
                        for source in ready:
                            chunk=source.recv(65536)
                            if not chunk:
                                self.server.relay_ends.append({'reason':'peer_eof','seconds':round(time.monotonic()-started,1)})
                                return
                            (upstream if source is channel else channel).sendall(chunk)
        except (OSError, ssl.SSLError) as error:
            self.server.relay_ends.append({'reason':type(error).__name__,'seconds':round(time.monotonic()-started,1)})


class RelayServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    daemon_threads = True


def token(identity, room, admin=False, permission="roomAdmin"):
    claims={"iss":KEY,"sub":identity,"nbf":int(time.time())-1,"exp":int(time.time())+30,
        "video":{"room":room,"roomJoin":not admin,"roomAdmin":admin,
                 "canPublish":False,"canSubscribe":not admin,"canPublishData":False}}
    if admin: claims["video"]={"room":room,permission:True}
    unsigned=_b64(b'{"alg":"HS256","typ":"JWT"}')+"."+_b64(json.dumps(claims).encode())
    return unsigned+"."+_b64(hmac.new(SECRET.encode(),unsigned.encode(),hashlib.sha256).digest())


def control(operation, room, **values):
    conn=http.client.HTTPConnection("127.0.0.1",7880,timeout=3)
    try:
        raw=json.dumps({"room":room,**values}).encode()
        permission={"DeleteRoom":"roomCreate","ListRooms":"roomList","ListParticipants":"roomAdmin",
                    "RemoveParticipant":"roomAdmin"}[operation]
        conn.request("POST","/twirp/livekit.RoomService/"+operation,raw,
                     {"Authorization":"Bearer "+token("component-control",room,True,permission),"Content-Type":"application/json"})
        response=conn.getresponse()
        body=response.read(65537)
        if response.status!=200 or len(body)>65536: raise RuntimeError("component_control_failed")
        return json.loads(body)
    finally:
        conn.close()


@unittest.skipUnless(os.environ.get("TEAMAIBOX_TEST_REAL_MEDIA")=="1" and importlib.util.find_spec("gi"),
                     "isolated ARM64 WebRTC test runtime required")
class ProductionBridgeMediaTest(unittest.TestCase):
    def test_production_appsrc_bridge_sends_and_decodes_audio_video(self):
        self.run_bridge(video_only_first=False)

    def test_video_starts_without_audio_and_late_audio_joins(self):
        self.run_bridge(video_only_first=True)

    def test_gdp_timestamp_faults_keep_audio_video(self):
        self.run_bridge(video_only_first=True, timestamp_faults=True)

    def test_format_changes_preserve_display_aspect(self):
        self.run_bridge(video_only_first=False, geometry_changes=True)

    def test_full_size_format_changes_preserve_display_aspect(self):
        self.run_bridge(video_only_first=False, geometry_changes=True, full_size=True)

    def test_stable_bitrate_format_changes_preserve_display_aspect(self):
        self.run_bridge(video_only_first=False, geometry_changes=True, full_size=True, stable_bitrate=True)

    def test_format_change_during_encoder_setup_uses_latest_geometry(self):
        self.run_bridge(video_only_first=False, geometry_changes=True, full_size=True,
                        stable_bitrate=True, startup_geometry_race=True)

    def run_bridge(self, *, video_only_first, timestamp_faults=False, geometry_changes=False, full_size=False, stable_bitrate=False, startup_geometry_race=False, impairment_observer=None, slow_viewer=False):
        # Test-only key/certificate are generated into container tmpfs and
        # removed on exit. The installed host/system trust store is untouched.
        with tempfile.TemporaryDirectory(prefix="cast-real-media-") as directory:
            root=Path(directory)
            def openssl(*args):
                subprocess.run(["openssl",*args],check=True,cwd=root,
                    stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            openssl("req","-x509","-newkey","rsa:2048","-nodes","-days","1",
                "-subj","/CN=Media Component Test CA","-addext","basicConstraints=critical,CA:TRUE",
                "-addext","keyUsage=critical,keyCertSign,cRLSign","-keyout","ca.key","-out","ca.crt")
            openssl("req","-new","-newkey","rsa:2048","-nodes","-subj","/CN=localhost",
                "-addext","subjectAltName=DNS:localhost","-addext","basicConstraints=critical,CA:FALSE",
                "-addext","extendedKeyUsage=serverAuth","-addext","keyUsage=critical,digitalSignature,keyEncipherment",
                "-keyout","test.key","-out","test.csr")
            openssl("x509","-req","-days","1","-in","test.csr","-CA","ca.crt","-CAkey","ca.key",
                "-set_serial","2","-copy_extensions","copy","-out","test.crt")
            os.environ["SSL_CERT_FILE"]=str(root/"ca.crt")
            import gi
            gi.require_version("Gst","1.0")
            from gi.repository import Gst
            Gst.init(None)
            server=RelayServer(("127.0.0.1",0),TlsRelay)
            server.tls=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            server.tls.minimum_version=server.tls.maximum_version=ssl.TLSVersion.TLSv1_3
            server.tls.load_cert_chain(str(root/"test.crt"),str(root/"test.key"))
            server.tls_versions=set()
            server.relay_ends=[]
            server.done=threading.Event()
            thread=threading.Thread(target=server.serve_forever,kwargs={"poll_interval":0.01},daemon=True)
            thread.start()
            session=str(uuid4())
            issuer=PublisherCredentialIssuer(api_key=KEY,api_secret=SECRET,
                endpoint="wss://localhost:"+str(server.server_address[1]))
            credential=issuer.issue(session_id=session,session_expires_at=int(time.time())+120)
            publisher=subscriber=bridge=second_subscriber=None
            feeders={}
            errors=[]
            sinks={}
            second_sinks={}
            ingress=None
            gdp_writers={}
            owned_fds=[]
            fault_counts={'duplicate':0,'missing':0,'backward':0,'forward':0}
            input_counts={'audio':0,'video':0}
            last_source_pts={}
            try:
                from services.trusted_media_service.webrtc_media_output import WebRtcMediaOutput
                from services.trusted_media_service.native_receiver_process import VIDEO_CONVERTER_PIPELINE
                bridge = WebRtcMediaOutput(credential=credential)
                if stable_bitrate:
                    # Freeze rate adaptation, not geometry: a format change
                    # must work without waiting for another bandwidth event.
                    bridge._sink.set_property('congestion-control', 'disabled')
                publisher = bridge._pipeline
                def bus_message(bus,message,data):
                    if message.type==Gst.MessageType.ERROR:
                        error,debug=message.parse_error()
                        detail=(error.message+' '+str(debug)).replace(SECRET,'[secret]')
                        detail=re.sub(r'[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}','[token]',detail)
                        detail=re.sub(r'(?:https?|wss?)://[^\s]+','[endpoint]',detail)
                        print(json.dumps({'syntheticError':detail[:1200]}),flush=True)
                    return Gst.BusSyncReply.PASS
                publisher.get_bus().set_sync_handler(bus_message,None)
                # The owner can wait well beyond the short publisher JWT TTL
                # before an Apple device supplies the first decoded frame.
                time.sleep(0 if video_only_first or geometry_changes or impairment_observer else 35)
                feeders = {
                    "video": Gst.parse_launch("videotestsrc is-live=true pattern=ball ! "
                        "capsfilter name=geometry caps=video/x-raw,format=Y444,width=640,height=480,framerate=60/1 ! "
                        + VIDEO_CONVERTER_PIPELINE + " ! appsink name=feed sync=false max-buffers=2 drop=true"),
                    "audio": Gst.parse_launch("audiotestsrc is-live=true wave=sine samplesperbuffer=352 ! "
                        "audio/x-raw,format=S16LE,rate="+str(44100 if video_only_first else 48000)+",channels=2 ! "
                        "appsink name=feed sync=false max-buffers=2 drop=true")}
                geometry_sequence = ((360,640,1,1), (640,360,1,1), (720,480,8,9), (360,640,1,1))
                if full_size:
                    geometry_sequence = ((498,1080,1,1), (1920,1080,1,1), (1920,1080,1,1), (498,1080,1,1))
                def geometry_caps(phase):
                    w,h,n,d = geometry_sequence[phase]
                    return Gst.Caps.from_string(f'video/x-raw,format=Y444,width={w},height={h},framerate=60/1,pixel-aspect-ratio={n}/{d}')
                if geometry_changes:
                    feeders['video'].get_by_name('geometry').set_property('caps', geometry_caps(0))
                for media, feeder in feeders.items():
                    if video_only_first and media == 'audio': continue
                    self.assertNotEqual(feeder.set_state(Gst.State.PLAYING), Gst.StateChangeReturn.FAILURE)
                if timestamp_faults:
                    from services.trusted_media_service.gdp_media_ingress import GdpMediaIngress
                    vr,vw=os.pipe();ar,aw=os.pipe();owned_fds=[vr,vw,ar,aw]
                    ingress=GdpMediaIngress(video_fd=vr,audio_fd=ar)
                    for media,fd in (('video',vw),('audio',aw)):
                        pipeline=Gst.parse_launch('appsrc name=feed is-live=true format=time ! gdppay ! fdsink sync=false fd='+str(fd))
                        pipeline.set_state(Gst.State.PLAYING)
                        gdp_writers[media]=pipeline
                publishing_sink=bridge._sink
                publishing_sink.set_property("stun-server",None)
                video_encoders={}
                encoder_setup_pending = threading.Event()
                def encoder_setup(element,consumer_id,pad_name,encoder):
                    # Record actual encoder identities. Reconcile session IDs
                    # with live SFU stats below: discovery has its own ID and
                    # must not be mistaken for another viewer's encoder.
                    if consumer_id and pad_name.startswith("video_"):
                        video_encoders[(consumer_id,pad_name)]=encoder
                        if startup_geometry_race and consumer_id != 'discovery':
                            encoder_setup_pending.set()
                            # Synthetic-only scheduling barrier: let a new
                            # input CAPS event precede encoder registration.
                            time.sleep(1)
                    return False  # Keep the plugin's normal setup/adaptation.
                publishing_sink.connect("encoder-setup",encoder_setup)
                signaller=publishing_sink.get_property("signaller")
                for name,value in (("ws-url",credential.endpoint),("room-name",credential.room),
                                   ("auth-token",credential.access_token),("timeout",5)):
                    signaller.set_property(name,value)
                subscriber=Gst.Pipeline.new(None)
                source=Gst.ElementFactory.make("livekitwebrtcsrc",None)
                source.set_property("stun-server",None)
                subscriber.add(source)
                receiving_signaller=source.get_property("signaller")
                viewer="synthetic-viewer-"+uuid4().hex
                for name,value in (("ws-url",credential.endpoint),("room-name",credential.room),
                                   ("auth-token",token(viewer,credential.room)),("timeout",5)):
                    receiving_signaller.set_property(name,value)
                def pad_added(element,pad):
                    try:
                        media="video" if pad.name.startswith("video_") else "audio" if pad.name.startswith("audio_") else None
                        if media is None or media in sinks: raise RuntimeError("unexpected_track")
                        sink=Gst.ElementFactory.make("appsink",None)
                        sink.set_property("caps",Gst.Caps.from_string(media+"/x-raw"))
                        for key,value in (("sync",False),("max-buffers",2),("drop",True),
                                          ("wait-on-eos",False),("enable-last-sample",False)):
                            sink.set_property(key,value)
                        subscriber.add(sink)
                        if pad.link(sink.get_static_pad("sink"))!=Gst.PadLinkReturn.OK: raise RuntimeError("track_link_failed")
                        sink.sync_state_with_parent()
                        sinks[media]=sink
                    except Exception:
                        errors.append("component_track_failed")
                source.connect("pad-added",pad_added)
                self.assertNotEqual(publisher.set_state(Gst.State.PLAYING),Gst.StateChangeReturn.FAILURE)
                self.assertNotEqual(subscriber.set_state(Gst.State.PLAYING),Gst.StateChangeReturn.FAILURE)
                counts={"video":0,"audio":0}
                start=time.monotonic()
                deadline=start+65
                audio_started=not video_only_first
                video_before_audio=0
                audible_audio=0
                restart_counts=None
                restarted=False
                geometry_phase=0
                geometry_counts=[{'matching':0,'wrong':0,'lastShape':None} for _ in geometry_sequence]
                second_counts={'video':0,'audio':0}
                second_viewer=None
                slow_ports=[]
                ports_before=set()
                def owned_udp_ports():
                    inodes=set()
                    for entry in Path('/proc/self/fd').iterdir():
                        try: link=os.readlink(entry)
                        except OSError: continue
                        if link.startswith('socket:['): inodes.add(link[8:-1])
                    ports=set()
                    for family in ('udp','udp6'):
                        for line in Path('/proc/self/net/'+family).read_text().splitlines()[1:]:
                            fields=line.split()
                            if fields[9] in inodes: ports.add(int(fields[1].split(':')[1],16))
                    return ports
                while (time.monotonic()-start<45 or not audio_started or min(counts.values())<10 or audible_audio<10) and time.monotonic()<deadline:
                    if slow_viewer and second_subscriber is None and min(counts.values())>=30:
                        ports_before=owned_udp_ports()
                        second_subscriber=Gst.Pipeline.new(None)
                        second_source=Gst.ElementFactory.make('livekitwebrtcsrc',None)
                        second_source.set_property('stun-server',None)
                        second_subscriber.add(second_source)
                        second_viewer='synthetic-slow-viewer-'+uuid4().hex
                        second_signaller=second_source.get_property('signaller')
                        for name,value in (("ws-url",credential.endpoint),("room-name",credential.room),
                                           ("auth-token",token(second_viewer,credential.room)),("timeout",5)):
                            second_signaller.set_property(name,value)
                        def second_pad_added(element,pad):
                            try:
                                track='video' if pad.name.startswith('video_') else 'audio' if pad.name.startswith('audio_') else None
                                if track is None or track in second_sinks: raise RuntimeError('unexpected_second_track')
                                sink=Gst.ElementFactory.make('appsink',None)
                                sink.set_property('caps',Gst.Caps.from_string(track+'/x-raw'))
                                for key,value in (('sync',False),('max-buffers',2),('drop',True),('wait-on-eos',False),('enable-last-sample',False)):
                                    sink.set_property(key,value)
                                second_subscriber.add(sink)
                                if pad.link(sink.get_static_pad('sink'))!=Gst.PadLinkReturn.OK: raise RuntimeError('second_track_link_failed')
                                sink.sync_state_with_parent();second_sinks[track]=sink
                            except Exception: errors.append('second_track_failed')
                        second_source.connect('pad-added',second_pad_added)
                        self.assertNotEqual(second_subscriber.set_state(Gst.State.PLAYING),Gst.StateChangeReturn.FAILURE)
                    if slow_viewer and second_subscriber is not None and not slow_ports and min(second_counts.values())>=10:
                        slow_ports=sorted(owned_udp_ports()-ports_before)
                        self.assertTrue(0<len(slow_ports)<=4,'identify only new viewer UDP ports')
                    if impairment_observer:
                        observation=bridge.snapshot()
                        if slow_viewer: observation.update(secondCounts=dict(second_counts),slowViewerPorts=slow_ports)
                        impairment_observer(time.monotonic()-start, dict(counts), observation)
                    phase=min(int((time.monotonic()-start)//10), 3)
                    if startup_geometry_race and encoder_setup_pending.is_set() and phase == 0:
                        phase = 1
                    if geometry_changes and phase != geometry_phase:
                        geometry_phase=phase
                        feeders['video'].get_by_name('geometry').set_property('caps', geometry_caps(phase))
                    if video_only_first and restart_counts is None and time.monotonic()-start>=35:
                        restart_counts=dict(counts)
                        for feeder in feeders.values():feeder.set_state(Gst.State.NULL)
                    if restart_counts is not None and not restarted:
                        if time.monotonic()-start<36:
                            time.sleep(0.005)
                            continue
                        for feeder in feeders.values():feeder.set_state(Gst.State.PLAYING)
                        restarted=True
                    if not audio_started and time.monotonic()-start >= 15:
                        video_before_audio=counts['video']
                        print(json.dumps({'videoBeforeAudio':video_before_audio,
                            'publisherProgress':bridge.snapshot()}),flush=True)
                        self.assertGreaterEqual(video_before_audio,10,
                            'silent screen mirroring must publish before any audio arrives')
                        feeders['audio'].set_state(Gst.State.PLAYING)
                        audio_started=True
                        counts['audio']=0
                    for media, feeder in feeders.items():
                        if media == 'audio' and not audio_started: continue
                        for _ in range(2):
                            sample = feeder.get_by_name("feed").try_pull_sample(0)
                            if sample is None: break
                            if ingress is None:
                                bridge.push(media, sample)
                            else:
                                incoming=sample.get_buffer();copied=incoming.copy()
                                input_counts[media]+=1;n=input_counts[media]
                                elapsed=time.monotonic()-start
                                shift=-5*Gst.SECOND if 23<=elapsed<28 else 20*Gst.SECOND if elapsed>=28 else 0
                                if shift and copied.pts!=Gst.CLOCK_TIME_NONE:
                                    copied.pts=max(0,copied.pts+shift)
                                    copied.unset_flags(Gst.BufferFlags.DISCONT)
                                    fault_counts['backward' if shift<0 else 'forward']+=1
                                if n%101==0:
                                    copied.pts=Gst.CLOCK_TIME_NONE;fault_counts['missing']+=1
                                elif n%67==0 and media in last_source_pts:
                                    copied.pts=last_source_pts[media];fault_counts['duplicate']+=1
                                else:last_source_pts[media]=copied.pts
                                source=gdp_writers[media].get_by_name('feed')
                                source.set_property('caps',sample.get_caps())
                                self.assertEqual(source.emit('push-buffer',copied),Gst.FlowReturn.OK)
                    if ingress is not None:
                        for media in ('audio','video'):
                            for _ in range(2):
                                sample=ingress.pull(media,timeout_ms=0)
                                if sample is not None:bridge.push(media,sample)
                    for pipeline in (publisher,subscriber):
                        message=pipeline.get_bus().pop_filtered(Gst.MessageType.ERROR)
                        if message is not None:
                            error,debug=message.parse_error()
                            # Only this isolated synthetic test emits bounded
                            # scrubbed diagnostics, never the deployed runtime.
                            detail=(error.message+" "+str(debug)).replace(SECRET,"[secret]")
                            detail=re.sub(r"[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}","[token]",detail)
                            detail=re.sub(r"(?:https?|wss?)://[^\s]+","[endpoint]",detail)
                            errors.append("gst_bus_"+error.domain+"_"+str(error.code)+":"+detail[:600])
                    if errors: break
                    for media,sink in list(second_sinks.items()):
                        if sink.emit('try-pull-sample',0) is not None: second_counts[media]+=1
                    for media,sink in list(sinks.items()):
                        sample=sink.emit("try-pull-sample",0)
                        if sample is not None:
                            self.assertEqual(sample.get_caps().get_structure(0).get_name(),media+"/x-raw")
                            self.assertGreater(sample.get_buffer().get_size(),0)
                            counts[media]+=1
                            if media=='video' and geometry_changes and time.monotonic()-start-phase*10 >= 3:
                                shape=sample.get_caps().get_structure(0)
                                w,h=shape.get_value('width'),shape.get_value('height')
                                sw,sh,n,d=geometry_sequence[phase]
                                row=geometry_counts[phase]
                                row['matching' if abs(w/h-sw*n/(sh*d))<.02 else 'wrong']+=1
                                row['lastShape']=[w,h]
                            if media=='audio' and audio_started:
                                fmt=sample.get_caps().get_structure(0).get_string('format')
                                raw=sample.get_buffer().extract_dup(0,sample.get_buffer().get_size())
                                code,scale={'S16LE':('h',32768),'S32LE':('i',2147483648),'F32LE':('f',1)}[fmt]
                                values=[x[0]/scale for x in struct.iter_unpack('<'+code,raw)]
                                if values and sum(x*x for x in values)/len(values)>0.005:
                                    audible_audio+=1
                    time.sleep(0.005)
                self.assertEqual(errors,[],"stable non-secret media error classes")
                if impairment_observer:
                    observation=bridge.snapshot()
                    if slow_viewer: observation.update(secondCounts=dict(second_counts),slowViewerPorts=slow_ports)
                    impairment_observer(time.monotonic()-start, dict(counts), observation, final=True)
                self.assertGreaterEqual(min(counts.values()),10,"real decrypted audio/video samples required")
                self.assertGreaterEqual(audible_audio,10,'decoded tone, not bootstrap silence, required')
                if geometry_changes:
                    print(json.dumps({'geometryPhases':geometry_counts,'sourceGeometry':geometry_sequence}),flush=True)
                    for row in geometry_counts[1:] if startup_geometry_race else geometry_counts:
                        self.assertGreaterEqual(row['matching'],20,'encoded display aspect must follow each source format')
                        self.assertEqual(row['wrong'],0,'stale encoder aspect after source format change')
                if video_only_first:self.assertGreaterEqual(video_before_audio,10)
                if video_only_first:
                    self.assertTrue(restarted)
                    for media in ('video','audio'):
                        self.assertGreater(counts[media]-restart_counts[media],30,
                            'both tracks must continue after source clock reset')
                if timestamp_faults:
                    self.assertTrue(all(value>0 for value in fault_counts.values()))
                    self.assertTrue(all(v['state']=='receiving' for v in ingress.snapshot()['tracks'].values()))
                self.assertEqual(server.tls_versions,{"TLSv1.3"})
                stats=publishing_sink.get_property("stats")
                self.assertEqual(stats.n_fields(),1,"exactly one SFU consumer, not one encoder per viewer")
                live_session=stats.nth_field_name(0)
                live_encoders=[encoder for (consumer_id,_),encoder in video_encoders.items() if consumer_id==live_session]
                self.assertEqual(len(live_encoders),1)
                self.assertEqual(live_encoders[0].get_factory().get_name(),"vp8enc")
                participants=control("ListParticipants",credential.room)["participants"]
                expected_participants={viewer,credential.identity}
                if second_viewer: expected_participants.add(second_viewer)
                self.assertEqual({p["identity"] for p in participants},expected_participants)
                control("RemoveParticipant",credential.room,identity=viewer)
                # Drain at most two queued samples, then verify media really
                # stops; a closed signalling socket alone is insufficient.
                time.sleep(1)
                for sink in list(sinks.values()):
                    while sink.emit("try-pull-sample",0) is not None: pass
                time.sleep(0.5)
                for sink in list(sinks.values()): self.assertIsNone(sink.emit("try-pull-sample",0))
                participants=control("ListParticipants",credential.room)["participants"]
                self.assertNotIn(viewer,{p["identity"] for p in participants})
                control("DeleteRoom",credential.room)
                self.assertEqual(control("ListRooms",credential.room,names=[credential.room]).get("rooms",[]),[])
                print(json.dumps({"realVideoSamples":counts["video"],"realAudioSamples":counts["audio"],
                    "timestampFaults":timestamp_faults,"faultCounts":fault_counts,
                    "videoOnlyFirst":video_only_first,"videoBeforeAudio":video_before_audio,
                    "audibleAudioBuffers":audible_audio,
                    "sourceRestartPassed":restarted,
                    "samplesAfterSourceRestart":{k:counts[k]-restart_counts[k] for k in counts} if restarted else {},
                    "tls13":True,"singleSfuConsumer":True,"oneVideoEncoder":True,"removedViewerMediaStopped":True,
                    "roomDeletionConfirmed":True,
                    "geometryChanges":geometry_changes,"geometryPhases":geometry_counts if geometry_changes else [],
                    "appleSenderAccepted":False,"browserAccepted":False,"hdmiAccepted":False}),flush=True)
            finally:
                for pipeline in (second_subscriber,subscriber,publisher,*feeders.values(),*gdp_writers.values()):
                    if pipeline is not None: pipeline.set_state(Gst.State.NULL)
                if ingress is not None:ingress.close()
                for fd in owned_fds:os.close(fd)
                if bridge is not None: bridge.close()
                issuer.close()
                try: control("DeleteRoom",credential.room)
                except Exception: pass
                server.done.set()
                server.shutdown()
                server.server_close()
                thread.join(2)
                print(json.dumps({'syntheticRelayEnds':server.relay_ends[:8]}),flush=True)


if __name__=="__main__": unittest.main()

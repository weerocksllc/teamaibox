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
        try:
            self.request.settimeout(3)
            with self.server.tls.wrap_socket(self.request, server_side=True) as channel:
                with socket.create_connection(("127.0.0.1", 7880), timeout=3) as upstream:
                    self.server.tls_versions.add(channel.version())
                    # Transparent private TLS relay, no request/token logging.
                    deadline = time.monotonic()+70
                    while time.monotonic()<deadline and not self.server.done.is_set():
                        ready, _, _ = select.select([channel, upstream], [], [], 0.05)
                        if channel.pending() and channel not in ready: ready.append(channel)
                        for source in ready:
                            chunk=source.recv(65536)
                            if not chunk: return
                            (upstream if source is channel else channel).sendall(chunk)
        except (OSError, ssl.SSLError):
            pass


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
class RealWebrtcMediaTest(unittest.TestCase):
    def test_encrypted_video_audio_and_actual_viewer_removal(self):
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
            server.done=threading.Event()
            thread=threading.Thread(target=server.serve_forever,kwargs={"poll_interval":0.01},daemon=True)
            thread.start()
            session=str(uuid4())
            issuer=PublisherCredentialIssuer(api_key=KEY,api_secret=SECRET,
                endpoint="wss://localhost:"+str(server.server_address[1]))
            credential=issuer.issue(session_id=session,session_expires_at=int(time.time())+120)
            publisher=subscriber=None
            errors=[]
            sinks={}
            try:
                publisher=Gst.parse_launch(
                    'livekitwebrtcsink name=publisher video-caps=video/x-vp8 audio-caps=audio/x-opus '
                    'congestion-control=homegrown min-bitrate=200000 start-bitrate=1000000 max-bitrate=2000000 '
                    'videotestsrc is-live=true pattern=ball ! video/x-raw,format=I420,width=320,height=240,framerate=15/1 '
                    '! queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 leaky=downstream ! publisher.video_0 '
                    'audiotestsrc is-live=true wave=sine ! audio/x-raw,format=S16LE,rate=48000,channels=2 '
                    '! queue max-size-buffers=2 max-size-bytes=0 max-size-time=0 leaky=downstream ! publisher.audio_0')
                publishing_sink=publisher.get_by_name("publisher")
                publishing_sink.set_property("stun-server",None)
                video_encoders={}
                def encoder_setup(element,consumer_id,pad_name,encoder):
                    # Record actual encoder identities. Reconcile session IDs
                    # with live SFU stats below: discovery has its own ID and
                    # must not be mistaken for another viewer's encoder.
                    if consumer_id and pad_name.startswith("video_"):
                        video_encoders[(consumer_id,pad_name)]=encoder
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
                deadline=time.monotonic()+35
                while min(counts.values())<10 and time.monotonic()<deadline:
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
                    for media,sink in list(sinks.items()):
                        sample=sink.emit("try-pull-sample",10*Gst.MSECOND)
                        if sample is not None:
                            self.assertEqual(sample.get_caps().get_structure(0).get_name(),media+"/x-raw")
                            self.assertGreater(sample.get_buffer().get_size(),0)
                            counts[media]+=1
                    time.sleep(0.01)
                self.assertEqual(errors,[],"stable non-secret media error classes")
                self.assertGreaterEqual(min(counts.values()),10,"real decrypted audio/video samples required")
                self.assertEqual(server.tls_versions,{"TLSv1.3"})
                stats=publishing_sink.get_property("stats")
                self.assertEqual(stats.n_fields(),1,"exactly one SFU consumer, not one encoder per viewer")
                live_session=stats.nth_field_name(0)
                live_encoders=[encoder for (consumer_id,_),encoder in video_encoders.items() if consumer_id==live_session]
                self.assertEqual(len(live_encoders),1)
                self.assertEqual(live_encoders[0].get_factory().get_name(),"vp8enc")
                participants=control("ListParticipants",credential.room)["participants"]
                self.assertEqual({p["identity"] for p in participants},{viewer,credential.identity})
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
                    "tls13":True,"singleSfuConsumer":True,"oneVideoEncoder":True,"removedViewerMediaStopped":True,
                    "roomDeletionConfirmed":True,
                    "appleSenderAccepted":False,"browserAccepted":False,"hdmiAccepted":False}),flush=True)
            finally:
                for pipeline in (subscriber,publisher):
                    if pipeline is not None: pipeline.set_state(Gst.State.NULL)
                issuer.close()
                try: control("DeleteRoom",credential.room)
                except Exception: pass
                server.done.set()
                server.shutdown()
                server.server_close()
                thread.join(2)


if __name__=="__main__": unittest.main()

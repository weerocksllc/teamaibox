"""Actual private GDP -> production publisher -> SFU -> eight Gst viewers.

Synthetic audio/video only. This does not impersonate eight authenticated Web
users, an Apple sender, an HDMI display, or a product acceptance journey.
"""
import importlib.util
import hashlib
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import ssl
import socket
import socketserver
import select
import re
import subprocess
import tempfile
import threading
import time
import unittest
from uuid import uuid4

from services.trusted_media_service.gdp_media_ingress import GdpMediaIngress
from services.trusted_media_service.publisher_credentials import PublisherCredentialIssuer
from services.trusted_media_service.webrtc_media_output import WebRtcMediaOutput
from services.trusted_media_service.livekit_browser_sink import LiveKitBrowserSink
from services.trusted_media_service.livekit_room_control import LiveKitRoomControl
from services.trusted_media_service.callback_client import callback_context
from services.trusted_media_service.viewer_token_issuer import LiveKitViewerTokenIssuer, ViewerTokenError
from tests.test_trusted_media_webrtc_real_media import token, control, SECRET, KEY
from services.trusted_media_runtime.sfu_gateway import PrivateSfuGateway
import services.trusted_media_runtime.sfu_gateway as gateway_module


class ComponentViewerBridge(socketserver.BaseRequestHandler):
    """Test-only stand-in for Platform's mTLS client, never a user grant.

    Gst's synthetic receivers cannot supply a client certificate themselves.
    They use this isolated loopback hop to exercise the production viewer
    gateway instead of incorrectly consuming publisher connection slots.
    """
    def handle(self):
        try:
            self.request.settimeout(3)
            with self.server.front_tls.wrap_socket(self.request,server_side=True) as channel:
                with socket.create_connection(self.server.target,timeout=3) as raw:
                    with self.server.client_tls.wrap_socket(raw,server_hostname="localhost") as upstream:
                        while not self.server.done.is_set():
                            ready,_,_=select.select([channel,upstream],[],[],0.1)
                            for stream in (channel,upstream):
                                if stream.pending() and stream not in ready: ready.append(stream)
                            for stream in ready:
                                data=stream.recv(16384)
                                if not data: return
                                (upstream if stream is channel else channel).sendall(data)
        except (OSError,ssl.SSLError): pass


class ComponentViewerServer(socketserver.ThreadingMixIn,socketserver.TCPServer):
    daemon_threads=True
    def handle_error(self,*_): pass


@unittest.skipUnless(os.environ.get("TEAMAIBOX_TEST_REAL_MEDIA") == "1" and importlib.util.find_spec("gi"),
                     "isolated ARM64 WebRTC test runtime required")
class RealFanoutTest(unittest.TestCase):
    def test_eight_receivers_share_one_actual_encoder_and_stop_cleans_media(self):
        self.maxDiff = None
        protocol_issues=[]
        original_prefix=gateway_module.request_prefix
        def diagnosed_prefix(reader,role):
            facts=[]
            class TraceReader:
                def readline(self,limit):
                    line=reader.readline(limit)
                    if not facts:
                        parts=line.split(b" ")
                        facts.append({"role":role,"method":parts[0].decode("ascii","replace"),
                            "path":parts[1].split(b"?",1)[0].decode("ascii","replace") if len(parts)>1 else "invalid",
                            "length":len(line)})
                    elif line!=b"\r\n": facts.append(line.split(b":",1)[0].decode("ascii","replace"))
                    return line
                def read(self,count): return reader.read(count)
            try: return original_prefix(TraceReader(),role)
            except Exception:
                protocol_issues.append(facts[:24])
                raise
        gateway_module.request_prefix=diagnosed_prefix
        self.addCleanup(setattr,gateway_module,"request_prefix",original_prefix)
        with tempfile.TemporaryDirectory(prefix="cast-fanout-") as directory:
            root = Path(directory)
            def openssl(*args):
                subprocess.run(["openssl", *args], check=True, cwd=root,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
            openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                "-subj", "/CN=Component Test CA", "-addext", "basicConstraints=critical,CA:TRUE",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", "ca.key", "-out", "ca.crt")
            openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost",
                "-addext", "subjectAltName=DNS:localhost", "-addext", "basicConstraints=critical,CA:FALSE",
                "-addext", "extendedKeyUsage=serverAuth,clientAuth", "-addext", "keyUsage=critical,digitalSignature,keyEncipherment",
                "-keyout", "test.key", "-out", "test.csr")
            openssl("x509", "-req", "-days", "1", "-in", "test.csr", "-CA", "ca.crt", "-CAkey", "ca.key",
                "-set_serial", "2", "-copy_extensions", "copy", "-out", "test.crt")
            os.environ["SSL_CERT_FILE"] = str(root / "ca.crt")
            import gi
            gi.require_version("Gst", "1.0")
            from gi.repository import Gst
            Gst.init(None)
            publisher_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            publisher_tls.minimum_version = publisher_tls.maximum_version = ssl.TLSVersion.TLSv1_3
            publisher_tls.load_cert_chain(str(root / "test.crt"), str(root / "test.key"))
            server = PrivateSfuGateway(("127.0.0.1", 0), role="publisher", upstream_port=7880, context=publisher_tls)
            relay = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
            relay.start()
            control_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            control_tls.minimum_version = control_tls.maximum_version = ssl.TLSVersion.TLSv1_3
            control_tls.load_cert_chain(str(root / "test.crt"), str(root / "test.key"))
            control_tls.load_verify_locations(str(root / "ca.crt"))
            control_tls.verify_mode = ssl.CERT_REQUIRED
            certificate = ssl.PEM_cert_to_DER_cert((root / "test.crt").read_text())
            private_control = PrivateSfuGateway(("127.0.0.1", 0), role="control", upstream_port=7880,
                context=control_tls, peer_fingerprint="sha256:" + hashlib.sha256(certificate).hexdigest())
            control_relay = threading.Thread(target=private_control.serve_forever,
                                             kwargs={"poll_interval": 0.01}, daemon=True)
            control_relay.start()
            viewer_gateway = PrivateSfuGateway(("127.0.0.1",0), role="viewer", upstream_port=7880,
                context=control_tls, peer_fingerprint="sha256:"+hashlib.sha256(certificate).hexdigest())
            viewer_thread=threading.Thread(target=viewer_gateway.serve_forever,kwargs={"poll_interval":0.01},daemon=True)
            viewer_thread.start()
            viewer_front=ComponentViewerServer(("127.0.0.1",0),ComponentViewerBridge)
            viewer_front.front_tls=publisher_tls
            viewer_front.client_tls=callback_context(certificate=root/"test.crt",private_key=root/"test.key",server_ca=root/"ca.crt")
            viewer_front.target=viewer_gateway.server_address
            viewer_front.done=threading.Event()
            viewer_front_thread=threading.Thread(target=viewer_front.serve_forever,kwargs={"poll_interval":0.01},daemon=True)
            viewer_front_thread.start()
            viewer_endpoint="wss://localhost:"+str(viewer_front.server_address[1])
            session = str(uuid4())
            issuer = PublisherCredentialIssuer(api_key=KEY, api_secret=SECRET,
                endpoint="wss://localhost:" + str(server.server_address[1]))
            credential = issuer.issue(session_id=session, session_expires_at=int(time.time()) + 120)
            certificate = ssl.PEM_cert_to_DER_cert((root / "test.crt").read_text())
            room_control = LiveKitRoomControl(api_key=KEY, api_secret=SECRET, address="127.0.0.1",
                port=private_control.server_address[1], server_name="localhost",
                certificate_fingerprint="sha256:" + hashlib.sha256(certificate).hexdigest(),
                tls_context=callback_context(certificate=root / "test.crt", private_key=root / "test.key",
                                             server_ca=root / "ca.crt"))
            now = [time.time()]
            viewer_issuer = LiveKitViewerTokenIssuer(api_key=KEY, api_secret=SECRET, maximum_viewers=8,
                endpoint=credential.endpoint, clock=lambda: now[0])
            def viewer_token(viewer_id):
                result = viewer_issuer.issue(session_id=session, viewer_identity_id=viewer_id,
                    grant_id=str(uuid4()), audience_revision=1, browser_instance_id="synthetic-browser-instance",
                    grant_expires_at=datetime.fromtimestamp(now[0] + 90, timezone.utc).isoformat().replace("+00:00", "Z"),
                    muted=False, maximum_viewers=8, publisher_encode_renditions=1)
                # Explicit component context, NOT authenticated Web identities.
                claim = viewer_issuer.consume(result["accessToken"], session_id=session, viewer_identity_id=viewer_id,
                                               browser_instance_id="synthetic-browser-instance")
                return claim["participantIdentity"], result["accessToken"]
            subscribers, sinks, generators, descriptors = [], [{} for _ in range(8)], [], []
            errors = []
            output = ingress = None
            pump_stop = threading.Event()
            pump = None
            try:
                video_read, video_write = os.pipe()
                audio_read, audio_write = os.pipe()
                descriptors.extend((video_read, video_write, audio_read, audio_write))
                ingress = GdpMediaIngress(video_fd=video_read, audio_fd=audio_read)
                output = LiveKitBrowserSink(session_id=session, expires_at=time.time() + 120,
                    room_control=room_control, publisher_issuer=issuer, viewer_issuer=viewer_issuer)
                output.start()
                self.assertFalse(output.snapshot()["healthy"], "process start is not media delivery")
                # A person may take more than the 30-second publisher-token
                # TTL to choose the receiver and enter its PIN. Model that
                # real pause before any paired audio/video reaches the sink.
                time.sleep(31)
                now[0] = time.time()
                identities, viewers = [], []
                for index in range(8):
                    pipeline = Gst.Pipeline.new(None)
                    source = Gst.ElementFactory.make("livekitwebrtcsrc", None)
                    source.set_property("stun-server", None)
                    pipeline.add(source)
                    signaller = source.get_property("signaller")
                    viewer_id = str(uuid4())
                    identity, bearer = viewer_token(viewer_id)
                    identities.append(identity)
                    viewers.append(viewer_id)
                    for name, value in (("ws-url", viewer_endpoint), ("room-name", credential.room),
                            ("auth-token", bearer), ("timeout", 5)):
                        signaller.set_property(name, value)
                    def added(element, pad, index=index, pipeline=pipeline):
                        try:
                            media = "video" if pad.name.startswith("video_") else "audio" if pad.name.startswith("audio_") else None
                            if media is None or media in sinks[index]:
                                raise RuntimeError()
                            sink = Gst.ElementFactory.make("appsink", None)
                            sink.set_property("caps", Gst.Caps.from_string(media + "/x-raw"))
                            for name, value in (("sync", False), ("max-buffers", 2), ("drop", True),
                                    ("wait-on-eos", False), ("enable-last-sample", False)):
                                sink.set_property(name, value)
                            pipeline.add(sink)
                            if pad.link(sink.get_static_pad("sink")) != Gst.PadLinkReturn.OK:
                                raise RuntimeError()
                            sink.sync_state_with_parent()
                            sinks[index][media] = sink
                        except Exception:
                            errors.append("component_track_failed")
                    source.connect("pad-added", added)
                    subscribers.append(pipeline)
                    self.assertNotEqual(pipeline.set_state(Gst.State.PLAYING), Gst.StateChangeReturn.FAILURE)
                for fd, source, caps in ((video_write, "videotestsrc",
                        "video/x-raw,format=I420,width=320,height=240,framerate=15/1"),
                        (audio_write, "audiotestsrc", "audio/x-raw,format=S16LE,rate=48000,channels=2")):
                    generators.append(subprocess.Popen(["gst-launch-1.0", "-q", source, "is-live=true", "!", caps,
                        "!", "gdppay", "!", "fdsink", "fd=1", "sync=false"], stdin=subprocess.DEVNULL,
                        stdout=fd, stderr=subprocess.DEVNULL, close_fds=True))
                def transfer():
                    try:
                        while not pump_stop.is_set():
                            for media in ("video", "audio"):
                                sample = ingress.pull(media, timeout_ms=10)
                                if sample is not None:
                                    output.push(media, sample)
                                    sample = None
                    except Exception:
                        if not pump_stop.is_set():
                            errors.append("component_transfer_failed")
                pump = threading.Thread(target=transfer, daemon=True)
                pump.start()
                counts = [{"video": 0, "audio": 0} for _ in range(8)]
                deadline = time.monotonic() + 45
                while min(min(count.values()) for count in counts) < 5 and time.monotonic() < deadline:
                    for index, pipeline in enumerate(subscribers):
                        failure = pipeline.get_bus().pop_filtered(Gst.MessageType.ERROR)
                        if failure:
                            cause, debug = failure.parse_error()
                            # Isolated synthetic fixture only. Preserve useful
                            # diagnostics without endpoint/JWT disclosure.
                            detail = re.sub(r"(?:https?|wss?)://[^\s]+", "[endpoint]", str(cause)+" "+str(debug))
                            detail = re.sub(r"[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", "[token]", detail)
                            errors.append("component_receive_failed:"+detail[:1600])
                        for media, sink in list(sinks[index].items()):
                            sample = sink.emit("try-pull-sample", 0)
                            if sample is not None:
                                self.assertGreater(sample.get_buffer().get_size(), 0)
                                counts[index][media] += 1
                    if errors:
                        break
                    time.sleep(0.01)
                self.assertEqual(errors, [], "safe protocol diagnostics: "+json.dumps(protocol_issues))
                self.assertGreaterEqual(min(min(count.values()) for count in counts), 5, str(counts))
                facts = output.snapshot()
                self.assertTrue(facts["healthy"], str(facts))
                self.assertEqual(facts["activeSfuConnections"], 1)
                self.assertEqual(facts["activeVideoEncoders"], 1)
                self.assertTrue(all(value <= 2 for value in facts["queuedSamples"].values()))
                for context in (server.context, private_control.context, viewer_gateway.context):
                    self.assertEqual(context.minimum_version, ssl.TLSVersion.TLSv1_3)
                    self.assertEqual(context.maximum_version, ssl.TLSVersion.TLSv1_3)
                participants = control("ListParticipants", credential.room)["participants"]
                self.assertEqual({item["identity"] for item in participants}, {*identities, credential.identity})
                # JWT expiry must not erase the eight existing connections.
                # Advancing only the admission clock does not end real media.
                now[0] += 31
                with self.assertRaisesRegex(ViewerTokenError, "viewer limit"):
                    viewer_token(str(uuid4()))
                output.disconnect_viewer(viewer_identity_id=viewers[0])
                self.assertEqual(viewer_issuer.connected_participants(session_id=session, viewer_identity_id=viewers[0]), ())
                time.sleep(1)
                for sink in sinks[0].values():
                    while sink.emit("try-pull-sample", 0) is not None:
                        pass
                time.sleep(0.5)
                for sink in sinks[0].values():
                    self.assertIsNone(sink.emit("try-pull-sample", 0))
                self.assertIsNotNone(sinks[1]["video"].emit("try-pull-sample", 100 * Gst.MSECOND))
                self.assertEqual(output.snapshot()["activeVideoEncoders"], 1)
                pump_stop.set()
                pump.join(2)
                self.assertFalse(pump.is_alive())
                output.close()
                output.close()
                self.assertEqual(output.snapshot(), {"healthy": False, "state": "closed"})
                time.sleep(1)
                for viewer_sinks in sinks[1:]:
                    for sink in viewer_sinks.values():
                        while sink.emit("try-pull-sample", 0) is not None:
                            pass
                time.sleep(0.5)
                for viewer_sinks in sinks[1:]:
                    for sink in viewer_sinks.values():
                        self.assertIsNone(sink.emit("try-pull-sample", 0))
                self.assertEqual(control("ListRooms", credential.room, names=[credential.room]).get("rooms", []), [])
                print(json.dumps({"realViewerCount": 8, "minimumDecodedVideoSamples": min(c["video"] for c in counts),
                    "minimumDecodedAudioSamples": min(c["audio"] for c in counts), "privateGdpIngress": True,
                    "productionPublisherAdapter": True, "productionSfuGateway": True, "productionViewerGateway": True,
                    "tls13": True, "oneVideoEncoder": True,
                    "productionBrowserSink": True, "pinnedMtlsRoomControl": True, "ninthAdmissionDeniedAfterTokenExpiry": True,
                    "mediaAfterPairingDelaySeconds": 31,
                    "singleSfuConnection": True, "queueBoundPerTrack": 2, "removedViewerMediaStopped": True,
                    "remainingViewerContinued": True, "publisherStopEndedAllMedia": True, "roomDeletionConfirmed": True,
                    "appleSenderAccepted": False, "browserAccepted": False, "hdmiAccepted": False}), flush=True)
            finally:
                pump_stop.set()
                if pump is not None:
                    pump.join(2)
                for pipeline in subscribers:
                    pipeline.set_state(Gst.State.NULL)
                if output is not None:
                    output.close()
                if ingress is not None:
                    ingress.close()
                for process in generators:
                    if process.poll() is None:
                        process.terminate()
                    process.wait(timeout=3)
                for fd in descriptors:
                    os.close(fd)
                issuer.close()
                try:
                    control("DeleteRoom", credential.room)
                except Exception:
                    pass
                server.server_close()
                server.shutdown()
                relay.join(2)
                private_control.server_close()
                private_control.shutdown()
                control_relay.join(2)
                viewer_front.done.set()
                viewer_gateway.server_close()
                viewer_gateway.shutdown()
                viewer_thread.join(2)
                viewer_front.shutdown()
                viewer_front.server_close()
                viewer_front_thread.join(2)


if __name__ == "__main__":
    unittest.main()

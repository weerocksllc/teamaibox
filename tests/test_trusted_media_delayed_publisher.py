"""Real isolated SFU test of the production room adapter after a 100 s wait.

Loaded with bridge_test helpers by an isolated integration harness. No host clock
changes, real Apple media, deployed SFU, persistent credentials or LAN port.
"""
import os
import unittest
try:
    from bridge_test import *
except ModuleNotFoundError as error:
    if error.name != 'bridge_test' or os.environ.get('TEAMAIBOX_REQUIRE_MEDIA_INTEGRATION') == '1':
        raise
    raise unittest.SkipTest('Requires an isolated SFU/bridge_test integration container') from error
from services.trusted_media_service.livekit_browser_sink import LiveKitBrowserSink
from services.trusted_media_service.viewer_token_issuer import LiveKitViewerTokenIssuer


class DelayedPublisherTest(unittest.TestCase):
    def test_room_waits_before_media(self):
        import gi
        gi.require_version("Gst", "1.0")
        from gi.repository import Gst
        from services.trusted_media_service.webrtc_media_output import WebRtcMediaOutput
        Gst.init(None)
        with tempfile.TemporaryDirectory(prefix="cast-delayed-test-") as directory:
            root = Path(directory)
            def openssl(*args):
                subprocess.run(["openssl", *args], cwd=root, check=True,
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                "-subj", "/CN=Test CA", "-addext", "basicConstraints=critical,CA:TRUE",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign", "-keyout", "ca.key", "-out", "ca.crt")
            openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost",
                "-addext", "subjectAltName=DNS:localhost", "-addext", "basicConstraints=critical,CA:FALSE",
                "-addext", "extendedKeyUsage=serverAuth", "-addext", "keyUsage=critical,digitalSignature,keyEncipherment",
                "-keyout", "key", "-out", "csr")
            openssl("x509", "-req", "-days", "1", "-in", "csr", "-CA", "ca.crt", "-CAkey", "ca.key",
                "-set_serial", "2", "-copy_extensions", "copy", "-out", "crt")
            os.environ["SSL_CERT_FILE"] = str(root / "ca.crt")
            server = RelayServer(("127.0.0.1", 0), TlsRelay)
            server.tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            server.tls.minimum_version = server.tls.maximum_version = ssl.TLSVersion.TLSv1_3
            server.tls.load_cert_chain(str(root / "crt"), str(root / "key"))
            server.tls_versions, server.relay_ends = set(), []
            server.done = threading.Event()
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": .01}, daemon=True)
            thread.start()
            endpoint = "wss://localhost:" + str(server.server_address[1])
            session = str(uuid4()); room = "cast-" + session.replace("-", "")
            publisher = PublisherCredentialIssuer(api_key=KEY, api_secret=SECRET, endpoint=endpoint)
            viewers = LiveKitViewerTokenIssuer(api_key=KEY, api_secret=SECRET, endpoint=endpoint)
            class Rooms:
                def create(self, **kw):
                    conn = http.client.HTTPConnection("127.0.0.1", 7880, timeout=3)
                    try:
                        conn.request("POST", "/twirp/livekit.RoomService/CreateRoom",
                            json.dumps({"name": room, "empty_timeout": 300}),
                            {"Authorization": "Bearer " + token("control", room, True, "roomCreate"),
                             "Content-Type": "application/json"})
                        response = conn.getresponse(); response.read()
                        if response.status != 200: raise RuntimeError("synthetic_create_failed")
                    finally: conn.close()
                def delete(self, **kw): control("DeleteRoom", room)
                def remove_viewer(self, **kw): control("RemoveParticipant", room, identity=kw["participant_identity"])
            outputs, issue_times, errors = [], [], []
            def bus_message(bus, message, data):
                if message.type == Gst.MessageType.ERROR:
                    error, debug = message.parse_error()
                    detail = (error.message + " " + str(debug)).replace(SECRET, "[secret]")
                    detail = re.sub(r"[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}", "[token]", detail)
                    detail = re.sub(r"(?:https?|wss?)://[^\s]+", "[endpoint]", detail)
                    errors.append(detail[:1000])
                return Gst.BusSyncReply.PASS
            def factory(**kw):
                issue_times.append(time.monotonic())
                value = WebRtcMediaOutput(**kw)
                value._pipeline.get_bus().set_sync_handler(bus_message, None)
                outputs.append(value)
                return value
            owner = LiveKitBrowserSink(session_id=session, expires_at=time.time() + 300,
                room_control=Rooms(), publisher_issuer=publisher, viewer_issuer=viewers,
                output_factory=factory)
            feeders, subscriber, sinks = {}, None, {}
            counts = {"video": 0, "audio": 0}; audible = 0
            try:
                start = time.monotonic(); owner.start()
                time.sleep(100)
                waited = time.monotonic() - start
                feeders = {"video": Gst.parse_launch("videotestsrc is-live=true pattern=ball ! "
                    "video/x-raw,format=I420,width=640,height=480,framerate=30/1 ! "
                    "appsink name=feed sync=false max-buffers=2 drop=true"),
                    "audio": Gst.parse_launch("audiotestsrc is-live=true wave=sine samplesperbuffer=352 ! "
                    "audio/x-raw,format=S16LE,rate=44100,channels=2 ! "
                    "appsink name=feed sync=false max-buffers=2 drop=true")}
                subscriber = Gst.Pipeline.new(None)
                source = Gst.ElementFactory.make("livekitwebrtcsrc", None)
                source.set_property("stun-server", None); subscriber.add(source)
                signaller = source.get_property("signaller")
                for key, value in (("ws-url", endpoint), ("room-name", room),
                        ("auth-token", token("synthetic-viewer", room)), ("timeout", 5)):
                    signaller.set_property(key, value)
                def pad_added(element, pad):
                    media = "video" if pad.name.startswith("video_") else "audio"
                    sink = Gst.ElementFactory.make("appsink", None)
                    sink.set_property("caps", Gst.Caps.from_string(media + "/x-raw"))
                    for key, value in (("sync", False), ("max-buffers", 2), ("drop", True), ("wait-on-eos", False)):
                        sink.set_property(key, value)
                    subscriber.add(sink)
                    if pad.link(sink.get_static_pad("sink")) != Gst.PadLinkReturn.OK:
                        errors.append("track_link_failed"); return
                    sink.sync_state_with_parent(); sinks[media] = sink
                source.connect("pad-added", pad_added)
                subscriber.set_state(Gst.State.PLAYING)
                for feeder in feeders.values(): feeder.set_state(Gst.State.PLAYING)
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline and not errors:
                    for media, feeder in feeders.items():
                        for _ in range(2):
                            sample = feeder.get_by_name("feed").emit("try-pull-sample", 0)
                            if sample is not None: owner.push(media, sample)
                    for media, sink in list(sinks.items()):
                        sample = sink.emit("try-pull-sample", 0)
                        if sample is None: continue
                        counts[media] += 1
                        if media == "audio":
                            buffer = sample.get_buffer(); raw = buffer.extract_dup(0, buffer.get_size())
                            fmt = sample.get_caps().get_structure(0).get_string("format")
                            code, scale = {"S16LE": ("h", 32768), "S32LE": ("i", 2147483648), "F32LE": ("f", 1)}[fmt]
                            values = [x[0] / scale for x in struct.iter_unpack("<" + code, raw)]
                            if values and sum(x*x for x in values)/len(values) > .005: audible += 1
                    time.sleep(.005)
                self.assertEqual(errors, [])
                self.assertGreaterEqual(counts["video"], 300)
                self.assertGreaterEqual(audible, 300)
                self.assertEqual(len(outputs), 1)
                self.assertGreaterEqual(issue_times[0] - start, 100)
                self.assertEqual(server.tls_versions, {"TLSv1.3"})
                self.assertTrue(owner.snapshot()["healthy"])
                self.assertEqual(len(control("ListParticipants", room)["participants"]), 2)
                owner.close()
                self.assertEqual(control("ListRooms", room, names=[room]).get("rooms", []), [])
                print(json.dumps({"delayedPublisher": True, "waitedSeconds": round(waited, 2),
                    "issuedAfterSeconds": round(issue_times[0] - start, 2), "realVideoSamples": counts["video"],
                    "realAudioSamples": counts["audio"], "audibleAudioBuffers": audible,
                    "tls13": True, "roomDeletionConfirmed": True, "appleSenderAccepted": False}), flush=True)
            finally:
                print(json.dumps({"syntheticPublisherErrors": errors[:3], "decodedSamples": counts}), flush=True)
                for feeder in feeders.values(): feeder.set_state(Gst.State.NULL)
                if subscriber is not None: subscriber.set_state(Gst.State.NULL)
                try: owner.close()
                finally:
                    publisher.close(); viewers.close()
                    server.done.set(); server.shutdown(); server.server_close(); thread.join(2)

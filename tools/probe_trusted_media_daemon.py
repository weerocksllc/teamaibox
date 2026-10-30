"""Actual ARM64 daemon/TLS lifecycle, using only ephemeral synthetic credentials.

Run in an owned, network-none container with /run/teamaibox on tmpfs. No media
session is requested, no receiver advertises, and no host devices are granted.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
import platform
from pathlib import Path
import signal
import socket
import ssl
import subprocess
import sys
import time
from uuid import uuid4

from services.trusted_media_runtime.main import CREDENTIAL_ROOT, require_tmpfs
from services.trusted_media_service.runtime_api import PLATFORM_PEER


def run():
    root = CREDENTIAL_ROOT
    root.mkdir(mode=0o700)  # Refuse any pre-existing credential directory.
    require_tmpfs(root)
    process = gateway_process = None
    connected_port = os.environ.get("TEAMAIBOX_COMPONENT_SFU_PORT")
    connected = connected_port is not None
    combined = os.environ.get("TEAMAIBOX_COMPONENT_COMBINED") == "1"
    assert not combined or connected
    report = {"status": "failed", "realTls": True, "syntheticCredentials": True,
              "mediaSessionRequested": False, "receiverAdvertised": False, "recording": False,
              "productAccepted": False, "appleSenderAccepted": False, "cleanupConfirmed": False}
    report["connectedSfuProbe"] = connected
    report["combinedApplianceOwner"] = combined
    try:
        assert platform.machine() == "aarch64" and os.getuid() == os.getgid() == 65532
        status = dict(line.split(":", 1) for line in Path("/proc/self/status").read_text().splitlines() if ":" in line)
        assert int(status["CapEff"].strip(), 16) == int(status["CapPrm"].strip(), 16) == 0
        assert status["NoNewPrivs"].strip() == "1"
        report["nonRootWithoutCapabilities"] = True
        image_root = Path("/opt/teamaibox")
        modules = sorted(path for package in ("trusted_media_service", "trusted_media_runtime")
                         for path in (image_root / "services" / package).rglob("*.py"))
        report["imageSources"] = {str(path.relative_to(image_root)): "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
                                  for path in modules}
        def openssl(*args):
            subprocess.run(["openssl", *args], cwd=root, check=True, stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Synthetic media daemon CA",
                "-keyout", "ca.key", "-out", "ca.crt", "-addext", "basicConstraints=critical,CA:TRUE",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign")
        for serial, (name, san, usage) in enumerate((
            ("server", "DNS:localhost", "serverAuth"),
            ("platform", "URI:" + PLATFORM_PEER, "clientAuth"),
            ("other", "URI:spiffe://teamaibox.internal/other-service", "clientAuth")), 2):
            openssl("req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=" + name,
                    "-keyout", name + ".key", "-out", name + ".csr")
            (root / (name + ".ext")).write_text("basicConstraints=critical,CA:FALSE\n"
                "keyUsage=critical,digitalSignature,keyEncipherment\n"
                f"extendedKeyUsage={usage}\nsubjectAltName={san}\n")
            openssl("x509", "-req", "-days", "1", "-in", name + ".csr", "-CA", "ca.crt", "-CAkey", "ca.key",
                    "-set_serial", str(serial), "-extfile", name + ".ext", "-out", name + ".crt")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]
        pin = "sha256:" + hashlib.sha256(ssl.PEM_cert_to_DER_cert((root / "server.crt").read_text())).hexdigest()
        peer = dict(address="127.0.0.1", port=port, serverName="localhost", certificateFingerprint=pin,
                    certificate="platform.crt", privateKey="platform.key", serverCa="ca.crt")
        config = dict(schemaVersion=2, identity={"nodeId": "10000000-0000-4000-8000-000000000001", "nodeGeneration": 2},
            interface="eth0", listener=dict(address="127.0.0.1", port=port,
            certificate="server.crt", privateKey="server.key", clientCa="ca.crt"), callback=dict(peer),
            sfu=dict(apiKeyFile="sfu-key", apiSecretFile="sfu-secret", control=dict(peer),
                     publisherEndpoint=f"wss://127.0.0.1:{port}", viewerEndpoint=f"wss://127.0.0.1:{port}"), hdmi=None)
        if connected:
            assert 1024 <= int(connected_port) <= 65535  # Explicit component endpoint.
            config["interface"] = os.environ["TEAMAIBOX_COMPONENT_INTERFACE"]
            config["identity"] = {"nodeId":os.environ['TEAMAIBOX_COMPONENT_NODE_ID'],"nodeGeneration":int(os.environ['TEAMAIBOX_COMPONENT_NODE_GENERATION'])}
            ports = [port]
            while len(ports) < 4:
                with socket.socket() as sock:
                    sock.bind(("127.0.0.1",0)); candidate=sock.getsockname()[1]
                if candidate not in ports: ports.append(candidate)
            client_pin="sha256:"+hashlib.sha256(ssl.PEM_cert_to_DER_cert((root/"platform.crt").read_text())).hexdigest()
            listeners=[]
            for role, gateway_port in zip(("publisher","control","viewer"),ports[1:]):
                listeners.append(dict(role=role,address="127.0.0.1",port=gateway_port,certificate="server.crt",privateKey="server.key",
                    clientCa=None if role=="publisher" else "ca.crt",peerFingerprint=None if role=="publisher" else client_pin))
            (root/"sfu-gateway.json").write_text(json.dumps({"schemaVersion":1,"upstreamPort":int(connected_port),"listeners":listeners}))
            config["sfu"]["control"]["port"]=ports[2]
            config["sfu"]["publisherEndpoint"]=f"wss://localhost:{ports[1]}"
            config["sfu"]["viewerEndpoint"]=f"wss://localhost:{ports[3]}"
        (root / "runtime.json").write_text(json.dumps(config))
        (root / "sfu-key").write_text("synthetic-daemon-key")
        (root / "sfu-secret").write_text("synthetic-daemon-secret-not-for-deployment")
        for path in root.iterdir(): path.chmod(0o400)
        if connected and not combined:
            gateway_process=subprocess.Popen([sys.executable,"-m","services.trusted_media_runtime.sfu_gateway"],
                stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
            deadline=time.monotonic()+8
            for gateway_port in ports[1:]:
                while True:
                    if gateway_process.poll() is not None: raise RuntimeError("cast_gateway_start_failed")
                    try:
                        with socket.create_connection(("127.0.0.1",gateway_port),timeout=0.2): break
                    except OSError:
                        if time.monotonic()>=deadline: raise RuntimeError("cast_gateway_start_timeout")
                        time.sleep(0.05)
        process = subprocess.Popen([sys.executable, "-m", "services.trusted_media_runtime.appliance" if combined else "services.trusted_media_runtime.main"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        deadline = time.monotonic() + 8
        while True:
            if process.poll() is not None: raise RuntimeError("cast_daemon_start_failed")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.2): break
            except OSError:
                if time.monotonic() >= deadline: raise RuntimeError("cast_daemon_start_timeout")
                time.sleep(0.05)

        def exchange(identity="platform", request_id=None, path=None):
            context = ssl.create_default_context(cafile=str(root / "ca.crt"))
            context.minimum_version = context.maximum_version = ssl.TLSVersion.TLSv1_3
            if identity is not None:
                context.load_cert_chain(str(root / (identity + ".crt")), str(root / (identity + ".key")))
            issued = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            target = path or f"/internal/v1/runtime/sessions/{uuid4()}/health"
            raw = (f"GET {target} HTTP/1.1\r\nHost: localhost\r\n"
                   f"X-TeamAIBox-Request-Id: {request_id or uuid4()}\r\nX-TeamAIBox-Request-Issued-At: {issued}\r\n\r\n").encode()
            with socket.create_connection(("127.0.0.1", port), timeout=3) as plain:
                with context.wrap_socket(plain, server_hostname="localhost") as channel:
                    assert channel.version() == "TLSv1.3"
                    channel.sendall(raw)
                    result = bytearray()
                    while data := channel.recv(4096): result.extend(data)
            return bytes(result)

        identity = str(uuid4())
        assert exchange(request_id=identity).startswith(b"HTTP/1.1 404")
        assert b"cast_runtime_request_replayed" in exchange(request_id=identity)
        assert exchange("other").startswith(b"HTTP/1.1 403")
        try:
            denied = exchange(None)
        except (ssl.SSLError, OSError):
            denied = b""
        assert not denied.startswith(b"HTTP/1.1 2")
        report["authenticatedControlPassed"] = True
        report["replayRejected"] = True
        report["otherServiceRejected"] = True
        report["unauthenticatedRejected"] = True
        ready = exchange(path="/internal/v1/runtime/readiness")
        assert ready.startswith(b"HTTP/1.1 200")
        facts = json.loads(ready.split(b"\r\n\r\n", 1)[1])
        report["observedReadiness"] = facts
        assert {key: facts[key] for key in ("nodeId", "nodeGeneration")} == config["identity"]
        if connected:
            assert facts["outputs"] == {"browser":{"available":True,"reasonCode":None},
                "hdmi":{"available":False,"reasonCode":"cast_hdmi_unconfigured"}}, "actual_browser_readiness_failed"
            report["realSfuReadinessPassed"] = True
        else:
            assert all(facts["outputs"][sink] == {"available": False, "reasonCode": "cast_media_runtime_unavailable"}
                       for sink in ("hdmi", "browser"))  # --network none, no devices; never invent availability.
        assert abs(datetime.now(timezone.utc).timestamp() - datetime.fromisoformat(facts["observedAt"].replace("Z", "+00:00")).timestamp()) < 5
        assert exchange("other", path="/internal/v1/runtime/readiness").startswith(b"HTTP/1.1 403")
        report["authenticatedReadinessPassed"] = True
        report["unavailableOutputsNotFaked"] = True
        # The genuine composed service must have no receiver/discovery child
        # after startup and these requests. No media session has been admitted.
        children = Path(f"/proc/{process.pid}/task/{process.pid}/children").read_text().strip()
        assert children == ""
        report["receiverChildrenBeforeStop"] = 0
        process.send_signal(signal.SIGTERM)
        code = process.wait(timeout=10)
        report["exitCode"] = code
        assert code == 0
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                raise RuntimeError("cast_daemon_listener_remained")
        except (ConnectionRefusedError, TimeoutError):
            pass
        report["listenerClosed"] = True
        if connected:
            if gateway_process is not None:
                gateway_process.terminate()
                report["gatewayExitCode"]=gateway_process.wait(timeout=10)
            else:
                report["gatewayExitCode"]=code  # The combined owner owns all gateway threads.
            assert report["gatewayExitCode"] == 0
            for gateway_port in ports[1:]:
                try:
                    with socket.create_connection(("127.0.0.1",gateway_port),timeout=0.2):
                        raise RuntimeError("cast_gateway_listener_remained")
                except (ConnectionRefusedError,TimeoutError): pass
            report["gatewayListenersClosed"] = True
        report["status"] = "passed"
    except Exception as error:
        # Only fixed error categories leave the container, never raw stderr,
        # certificates, configuration, receiver labels or private credentials.
        report["errorCategory"] = type(error).__name__
    finally:
        for owned_process in (process,gateway_process):
          if owned_process is not None:
            if owned_process.poll() is None:
                owned_process.terminate()
                try: owned_process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    owned_process.kill(); owned_process.wait(timeout=5)
            if owned_process.stderr is not None: owned_process.stderr.close()
        for path in root.iterdir(): path.unlink()
        root.rmdir()
        report["cleanupConfirmed"] = all(p is None or p.poll() is not None for p in (process,gateway_process))
    print(json.dumps(report, sort_keys=True))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__": sys.exit(run())

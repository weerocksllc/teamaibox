"""Private mTLS control daemon. Starting it never advertises a receiver.

The deployment controller owns resource admission and the paired SFU. Platform
must authenticate a casting session before POSTing to this listener. This entry point
does not grant admission, stop a desktop, install drivers or open Docker.
Configuration and credentials are supplied exclusively on private tmpfs.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import signal
import ssl
import stat
import sys
import threading
import time

from services.trusted_media_service.callback_client import TrustedMediaCallbackClient, callback_context
from services.trusted_media_service.livekit_room_control import LiveKitRoomControl
from services.trusted_media_service.runtime_composition import TrustedMediaRuntime
from services.trusted_media_service.tls_runtime_server import TrustedMediaTlsServer, server_context
from services.trusted_media_service.output_readiness import node_identity


CREDENTIAL_ROOT = Path("/run/teamaibox/credentials")
MAX_INPUT = 64 * 1024


class ConfigurationError(ValueError):
    def __init__(self):
        super().__init__("cast_service_configuration_invalid")


def require_tmpfs(root):
    """Check the longest matching mount, not an unrelated tmpfs ancestor."""
    matches = []
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        before, after = line.split(" - ", 1)
        mount = Path(before.split()[4])
        if mount == root or mount in root.parents:
            matches.append((len(mount.parts), after.split()[0]))
    if not matches or max(matches)[1] != "tmpfs":
        raise ConfigurationError()


class ProtectedInputs:
    """Hold exact no-follow file descriptors through TLS-context construction."""
    def __init__(self, root=CREDENTIAL_ROOT, *, mount_check=require_tmpfs):
        self._files = []
        self._directory = None
        try:
            root = Path(root)
            if not root.is_absolute() or root.resolve(strict=True) != root:
                raise ConfigurationError()
            mount_check(root)
            self._directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            info = os.fstat(self._directory)
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) not in (0o500, 0o700):
                raise ConfigurationError()
            self._root = root
        except Exception:
            self.close()
            raise ConfigurationError() from None

    def _open(self, name):
        if self._directory is None or not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", name):
            raise ConfigurationError()
        fd = None
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=self._directory)
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) not in (0o400, 0o600) or not 1 <= info.st_size <= MAX_INPUT):
                raise ConfigurationError()
            self._files.append(fd)
            return fd
        except Exception:
            if fd is not None:
                os.close(fd)
            raise ConfigurationError() from None

    def read(self, name):
        fd = self._open(name)
        chunks = bytearray()
        while len(chunks) <= MAX_INPUT:
            chunk = os.read(fd, min(4096, MAX_INPUT + 1 - len(chunks)))
            if not chunk:
                return chunks
            chunks.extend(chunk)
        chunks[:] = b"\0" * len(chunks)
        raise ConfigurationError()

    def tls_path(self, name):
        # Linux deployment only. SSL opens this exact held descriptor, so a
        # path replacement cannot substitute credentials after validation.
        return Path("/proc/self/fd") / str(self._open(name))

    def publisher_ca_path(self, name):
        # Python control clients receive explicit TLS contexts; the native
        # GStreamer publisher instead reads SSL_CERT_FILE lazily. Validate the
        # same CA now, then give it the stable read-only mount path, not an fd
        # that ProtectedInputs.close() will close before the phone connects.
        raw = self.read(name)
        try:
            ssl.create_default_context(cadata=raw.decode("ascii"))
        finally:
            raw[:] = b"\0" * len(raw)
        return str(self._root / name)

    def close(self):
        for fd in self._files:
            os.close(fd)
        self._files.clear()
        if self._directory is not None:
            os.close(self._directory)
            self._directory = None

    def __enter__(self): return self
    def __exit__(self, *_): self.close()


def exact(value, keys):
    if type(value) is not dict or set(value) != set(keys):
        raise ConfigurationError()
    return value


def unique_object(pairs):
    result = {}
    for name, value in pairs:
        if name in result:
            raise ConfigurationError()
        result[name] = value
    return result


def configuration(inputs):
    raw = inputs.read("runtime.json")
    try:
        config = json.loads(raw, object_pairs_hook=unique_object)
        if type(config) is not dict or type(config.get("schemaVersion")) is not int or config["schemaVersion"] not in (1, 2):
            raise ConfigurationError()
        exact(config, ("schemaVersion", "interface", "listener", "callback", "sfu")
              + (("hdmi",) if "hdmi" in config else ())
              + (("identity",) if config["schemaVersion"] == 2 else ()))
        if config["schemaVersion"] == 2:
            node_identity(config["identity"])
        exact(config["listener"], ("address", "port", "certificate", "privateKey", "clientCa"))
        peer_keys = ("address", "port", "serverName", "certificateFingerprint", "certificate", "privateKey", "serverCa")
        exact(config["callback"], peer_keys)
        exact(config["sfu"], ("apiKeyFile", "apiSecretFile", "control", "publisherEndpoint", "viewerEndpoint"))
        exact(config["sfu"]["control"], peer_keys)
        if config.get("hdmi") is not None:
            raise ConfigurationError()
        return config
    except Exception:
        raise ConfigurationError() from None
    finally:
        raw[:] = b"\0" * len(raw)


def peer_options(inputs, peer):
    return dict(address=peer["address"], port=peer["port"], server_name=peer["serverName"],
        certificate_fingerprint=peer["certificateFingerprint"], tls_context=callback_context(
            certificate=inputs.tls_path(peer["certificate"]), private_key=inputs.tls_path(peer["privateKey"]),
            server_ca=inputs.tls_path(peer["serverCa"])))


class RuntimeService:
    def __init__(self, runtime, server):
        self.runtime, self.server = runtime, server
        self._closed = False

    def close(self):
        if not self._closed:
            # Stop accepting connections first. API.shutdown also rejects any
            # in-flight authenticated request after acquiring its own lock.
            self.server.server_close()
            self.runtime.close()
            self._closed = True  # Failed media cleanup retains ownership.

    def serve(self, stop_event):
        self.server.timeout = 0.2
        try:
            while not stop_event.is_set():
                self.server.handle_request()
                self.server.service_actions()  # Expiry works without Platform.
        finally:
            self.close()


def assemble(inputs):
    """Construct production components and bind TLS, with no media side effects."""
    rooms = runtime = None
    key = secret = None
    try:
        config = configuration(inputs)
        # Configure once at service startup, before runtime/GStreamer creation.
        # Do not depend on a particular deployment script remembering this env.
        os.environ["SSL_CERT_FILE"] = inputs.publisher_ca_path(config["sfu"]["control"]["serverCa"])
        callback = TrustedMediaCallbackClient(**peer_options(inputs, config["callback"]))
        sfu = config["sfu"]
        key, secret = inputs.read(sfu["apiKeyFile"]), inputs.read(sfu["apiSecretFile"])
        api_key, api_secret = key.decode("utf-8"), secret.decode("utf-8")
        if any(c.isspace() for c in api_key + api_secret):
            raise ConfigurationError()
        rooms = LiveKitRoomControl(api_key=api_key, api_secret=api_secret, **peer_options(inputs, sfu["control"]))
        runtime = TrustedMediaRuntime(callback_client=callback, room_control=rooms, api_key=api_key, api_secret=api_secret,
            private_publisher_endpoint=sfu["publisherEndpoint"], viewer_endpoint=sfu["viewerEndpoint"],
            interface=config["interface"], identity=config.get("identity"))
        listener = config["listener"]
        server = TrustedMediaTlsServer((listener["address"], listener["port"]), api=runtime.api,
            tls_context=server_context(certificate=inputs.tls_path(listener["certificate"]),
                private_key=inputs.tls_path(listener["privateKey"]), client_ca=inputs.tls_path(listener["clientCa"])))
        return RuntimeService(runtime, server)
    except Exception:
        if runtime is not None:
            runtime.close()
        elif rooms is not None:
            rooms.close()
        raise ConfigurationError() from None
    finally:
        for raw in (key, secret):
            if raw is not None:
                raw[:] = b"\0" * len(raw)


def main():
    owner = None
    try:
        if len(sys.argv) != 1 or os.geteuid() == 0 or os.environ.get("UXPLAYRC"):
            raise ConfigurationError()
        stop = threading.Event()
        for signum in (signal.SIGTERM, signal.SIGINT):
            signal.signal(signum, lambda *_: stop.set())
        with ProtectedInputs() as inputs:
            owner = assemble(inputs)
        owner.serve(stop)
        return 0
    except ConfigurationError:
        print("cast_service_configuration_invalid", file=sys.stderr)
        return 78
    except Exception:
        print("cast_service_stopped_with_error", file=sys.stderr)
        return 1
    finally:
        if owner is not None:
            # Retry exact owned cleanup, never launch another receiver or erase
            # an uncertain SFU room. The container controller handles exit != 0.
            deadline = time.monotonic() + 10
            while not owner._closed:
                try:
                    owner.close()
                except Exception:
                    if time.monotonic() >= deadline:
                        break
                    time.sleep(0.2)


if __name__ == "__main__":
    sys.exit(main())

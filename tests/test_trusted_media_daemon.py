"""Daemon wiring and private-input tests; not Apple or product acceptance."""
import contextlib
import io
import json
import os
from pathlib import Path
import ssl
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch

from services.trusted_media_runtime import main as daemon


def policy():
    peer = dict(address="127.0.0.1", port=7780, serverName="localhost", certificateFingerprint="sha256:" + "1" * 64,
                certificate="client.crt", privateKey="client.key", serverCa="ca.crt")
    return dict(schemaVersion=1, interface="eth0", listener=dict(address="127.0.0.1", port=7782,
        certificate="server.crt", privateKey="server.key", clientCa="ca.crt"), callback=dict(peer),
        sfu=dict(apiKeyFile="sfu-key", apiSecretFile="sfu-secret", control=dict(peer),
            publisherEndpoint="wss://127.0.0.1:7780", viewerEndpoint="wss://127.0.0.1:7781"),
        hdmi=None)


class Inputs:
    def __init__(self, config=None):
        self.values = {"runtime.json": json.dumps(config or policy()).encode(), "sfu-key": b"synthetic-api-key",
                       "sfu-secret": b"synthetic-test-secret-not-for-deployment"}
        self.returned = []

    def read(self, name):
        value = bytearray(self.values[name])
        self.returned.append(value)
        return value

    def tls_path(self, name): return Path("/synthetic-test-only") / name

    def publisher_ca_path(self, name): return str(Path("/synthetic-test-only") / name)


class ProtectedInputsTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="media-inputs-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.root.chmod(0o700)

    def file(self, name="test.key", content=b"synthetic-secret"):
        file = self.root / name
        file.write_bytes(content)
        file.chmod(0o600)
        return file

    def inputs(self):
        result = daemon.ProtectedInputs(self.root, mount_check=lambda root: None)
        self.addCleanup(result.close)
        return result

    def test_private_file_read_exact_descriptor_and_close(self):
        self.file()
        inputs = self.inputs()
        self.assertEqual(inputs.read("test.key"), b"synthetic-secret")
        fd = inputs._files[0]
        inputs.close()
        inputs.close()
        with self.assertRaises(OSError): os.fstat(fd)
        with self.assertRaises(daemon.ConfigurationError): inputs.read("test.key")

    def test_publisher_ca_uses_validated_file_and_stable_mount_not_closed_fd(self):
        self.file("ca.crt", b"synthetic-ca")
        inputs = self.inputs()
        with patch.object(daemon.ssl, "create_default_context") as context:
            path = inputs.publisher_ca_path("ca.crt")
        self.assertEqual(context.call_args.kwargs, {"cadata": "synthetic-ca"})
        inputs.close()
        self.assertEqual(path, str(self.root / "ca.crt"))
        self.assertTrue(Path(path).is_file())

    def test_publisher_missing_invalid_or_symlink_ca_fails_before_runtime(self):
        inputs = self.inputs()
        with self.assertRaises(daemon.ConfigurationError): inputs.publisher_ca_path("missing.crt")
        self.file("ca.crt", b"not-a-certificate")
        with self.assertRaises(ssl.SSLError): inputs.publisher_ca_path("ca.crt")
        (self.root / "alias.crt").symlink_to(self.root / "ca.crt")
        with self.assertRaises(daemon.ConfigurationError): inputs.publisher_ca_path("alias.crt")

    def test_paths_symlinks_hardlinks_and_fifo_are_rejected(self):
        file = self.file()
        (self.root / "linked.key").symlink_to(file)
        os.mkfifo(self.root / "pipe.key", 0o600)
        inputs = self.inputs()
        for value in ("../test.key", "/tmp/test.key", "linked.key", "pipe.key", None, "x\nkey"):
            with self.subTest(value=value), self.assertRaises(daemon.ConfigurationError): inputs.read(value)
        os.link(file, self.root / "hard.key")
        with self.assertRaises(daemon.ConfigurationError): inputs.read("test.key")

    def test_public_permissions_wrong_owner_empty_and_oversize_rejected(self):
        file = self.file()
        inputs = self.inputs()
        for mode in (0o644, 0o660, 0o777):
            file.chmod(mode)
            with self.assertRaises(daemon.ConfigurationError): inputs.read("test.key")
        file.chmod(0o600)
        with patch.object(daemon.os, "geteuid", return_value=os.geteuid() + 1):
            with self.assertRaises(daemon.ConfigurationError): inputs.read("test.key")
        for contents in (b"", b"x" * (daemon.MAX_INPUT + 1)):
            file.write_bytes(contents)
            with self.assertRaises(daemon.ConfigurationError): inputs.read("test.key")

    def test_root_permissions_symlinks_and_non_tmpfs_rejected(self):
        self.root.chmod(0o755)
        with self.assertRaises(daemon.ConfigurationError): self.inputs()
        self.root.chmod(0o700)
        link = self.root / "alias"
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(daemon.ConfigurationError): daemon.ProtectedInputs(link, mount_check=lambda _: None)
        with self.assertRaises(daemon.ConfigurationError):
            daemon.ProtectedInputs(self.root, mount_check=Mock(side_effect=ValueError("not tmpfs")))

    def test_deepest_mount_must_be_tmpfs_not_a_persistent_submount(self):
        root = Path("/run/teamaibox/credentials")
        mounts = "1 0 0:1 / / rw - ext4 /dev/root rw\n2 1 0:2 / /run/teamaibox rw - tmpfs tmpfs rw\n"
        with patch.object(Path, "read_text", return_value=mounts): daemon.require_tmpfs(root)
        mounts += "3 2 0:3 / /run/teamaibox/credentials rw - ext4 /dev/data rw\n"
        with patch.object(Path, "read_text", return_value=mounts), self.assertRaises(daemon.ConfigurationError):
            daemon.require_tmpfs(root)


class ConfigurationTest(unittest.TestCase):
    def test_v2_requires_exact_node_identity_and_v1_does_not_claim_readiness(self):
        config = policy()
        config.update(schemaVersion=2, identity={"nodeId": "10000000-0000-4000-8000-000000000001", "nodeGeneration": 2})
        self.assertEqual(daemon.configuration(Inputs(config)), config)
        for changed in ({**config, "identity": {}}, {**config, "schemaVersion": 1}):
            with self.assertRaises(daemon.ConfigurationError): daemon.configuration(Inputs(changed))

    def test_exact_fields_and_duplicate_fields_rejected_and_input_wiped(self):
        config = policy()
        self.assertEqual(daemon.configuration(Inputs(config)), config)
        bad = []
        for key in ("pin", "command", "dockerSocket"):
            value = policy(); value[key] = "forbidden"; bad.append(json.dumps(value).encode())
        value = policy(); value["hdmi"] = {"devicePath": "/dev/dri/card0"}; bad.append(json.dumps(value).encode())
        value = policy(); value["schemaVersion"] = True; bad.append(json.dumps(value).encode())
        bad.append(json.dumps(policy()).replace('"schemaVersion": 1', '"schemaVersion": 1, "schemaVersion": 1').encode())
        for raw in bad:
            inputs = Inputs(); inputs.values["runtime.json"] = raw
            with self.assertRaises(daemon.ConfigurationError): daemon.configuration(inputs)
            self.assertTrue(all(not any(value) for value in inputs.returned))


class AssemblyTest(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ)
        environment.start(); self.addCleanup(environment.stop)
        if not ssl.HAS_TLSv1_3:
            self.skipTest("TLS 1.3 runtime required")
        context = ssl.create_default_context()
        context.minimum_version = context.maximum_version = ssl.TLSVersion.TLSv1_3
        def options(inputs, peer):
            return dict(address=peer["address"], port=peer["port"], server_name=peer["serverName"],
                        certificate_fingerprint=peer["certificateFingerprint"], tls_context=context)
        self.patch = patch.object(daemon, "peer_options", side_effect=options)
        self.patch.start(); self.addCleanup(self.patch.stop)
        self.context_patch = patch.object(daemon, "server_context", return_value=Mock())
        self.context_patch.start(); self.addCleanup(self.context_patch.stop)

    def test_assembly_starts_no_discovery_device_or_room_and_wipes_read_buffers(self):
        inputs = Inputs()
        with patch.object(daemon, "TrustedMediaTlsServer") as listener, \
             patch("services.trusted_media_service.runtime_composition.DiscoverableReceiverProcess") as receiver, \
             patch("services.trusted_media_service.hdmi_media_output.KmsDevice.acquire") as device, \
             patch("services.trusted_media_service.livekit_room_control.LiveKitRoomControl._post") as sfu:
            owner = daemon.assemble(inputs)
            self.assertEqual(os.environ["SSL_CERT_FILE"], "/synthetic-test-only/ca.crt")
            receiver.assert_not_called(); device.assert_not_called(); sfu.assert_not_called()
            self.assertIsNone(owner.runtime.api._active)
            self.assertTrue(all(not any(value) for value in inputs.returned))
            self.assertEqual(listener.call_args.args, (("127.0.0.1", 7782),))
            owner.close(); owner.close()
            self.assertTrue(owner.runtime._rooms._closed)
            self.assertTrue(owner.runtime._publisher._closed)
            listener.return_value.server_close.assert_called_once()

    def test_startup_repairs_missing_or_stale_publisher_trust(self):
        for previous in (None, "/stale/old-ca.crt"):
            with self.subTest(previous=previous), patch.object(daemon, "TrustedMediaTlsServer"):
                if previous is None:
                    os.environ.pop("SSL_CERT_FILE", None)
                else:
                    os.environ["SSL_CERT_FILE"] = previous
                owner = daemon.assemble(Inputs())
                self.assertEqual(os.environ["SSL_CERT_FILE"], "/synthetic-test-only/ca.crt")
                owner.close()

    def test_invalid_publisher_trust_blocks_before_any_runtime_or_listener(self):
        inputs = Inputs()
        inputs.publisher_ca_path = Mock(side_effect=ssl.SSLError("invalid private CA"))
        with patch.object(daemon, "TrustedMediaRuntime") as runtime, \
             patch.object(daemon, "TrustedMediaTlsServer") as listener:
            with self.assertRaises(daemon.ConfigurationError): daemon.assemble(inputs)
        runtime.assert_not_called(); listener.assert_not_called()

    def test_listener_failure_cleans_issuers_and_never_advertises(self):
        runtime_class = daemon.TrustedMediaRuntime
        created = []
        def construct(**kwargs):
            value = runtime_class(**kwargs); created.append(value); return value
        with patch.object(daemon, "TrustedMediaRuntime", side_effect=construct), \
             patch.object(daemon, "TrustedMediaTlsServer", side_effect=OSError("address already in use")):
            with self.assertRaisesRegex(daemon.ConfigurationError, "^cast_service_configuration_invalid$"):
                daemon.assemble(Inputs())
        self.assertEqual(len(created), 1)
        self.assertTrue(created[0]._closed)
        self.assertTrue(created[0]._rooms._closed)


class LifecycleTest(unittest.TestCase):
    def test_stop_closes_listener_before_runtime_and_expiry_ticks_without_requests(self):
        events = []
        stop = threading.Event()
        server, runtime = Mock(), Mock()
        server.handle_request.side_effect = lambda: stop.set()
        server.server_close.side_effect = lambda: events.append("listener")
        runtime.close.side_effect = lambda: events.append("runtime")
        owner = daemon.RuntimeService(runtime, server)
        owner.serve(stop)
        self.assertEqual(events, ["listener", "runtime"])
        server.service_actions.assert_called_once()
        self.assertTrue(owner._closed)

    def test_failed_cleanup_retains_owner_until_exact_retry_succeeds(self):
        runtime, server = Mock(), Mock()
        runtime.close.side_effect = [RuntimeError("pending"), None]
        owner = daemon.RuntimeService(runtime, server)
        with self.assertRaises(RuntimeError): owner.close()
        self.assertFalse(owner._closed)
        owner.close()
        self.assertTrue(owner._closed)
        self.assertEqual(runtime.close.call_count, 2)

    def test_main_missing_configuration_is_redacted_and_never_falls_back_to_uxplay(self):
        output = io.StringIO()
        with patch.object(daemon.os, "geteuid", return_value=65532), \
             patch.object(daemon.sys, "argv", ["media-service"]), patch.dict(os.environ, {"UXPLAYRC": ""}), \
             patch.object(daemon, "ProtectedInputs", side_effect=daemon.ConfigurationError()), \
             contextlib.redirect_stderr(output):
            self.assertEqual(daemon.main(), 78)
        self.assertEqual(output.getvalue(), "cast_service_configuration_invalid\n")


if __name__ == "__main__": unittest.main()

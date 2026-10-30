from __future__ import annotations

import inspect
import pathlib
import unittest

from tools.deploy_spark_authenticated_preview import (
    API,
    AuthenticatedPreviewError,
    DEFAULT_TARGET,
    EDGE_NETWORK,
    NETWORK,
    SAFE_IMAGE_ID,
    TARGETS,
    _api_command,
    _persistence_probe_command,
    _connect_web_to_api_network,
    _generate_tls,
    _repository_evidence_path,
    _setup_api_command,
    _target_config,
    _web_command,
    deploy,
)


ROOT = pathlib.Path(__file__).resolve().parents[1]


class AuthenticatedPreviewTests(unittest.TestCase):
    def test_production_persistence_probe_is_non_root_read_only_and_offline(self) -> None:
        command = _persistence_probe_command(
            "teamaibox-auth-persistence-probe-20260812-test-a1",
            "sha256:" + "a" * 64,
            "20260812-test-a1",
        )
        rendered = " ".join(command)
        self.assertIn("--network none", rendered)
        self.assertIn("--read-only", command)
        self.assertIn("--user 1000:1000", rendered)
        self.assertNotIn("PLATFORM_API_PERSISTENCE", rendered)
        self.assertNotIn("--publish", command)

    def test_only_the_local_appliance_is_selectable(self) -> None:
        self.assertEqual(DEFAULT_TARGET, "dgx-spark-dev-01")
        self.assertEqual(
            TARGETS,
            {
                "dgx-spark-dev-01": {"ssh": "operator@10.64.0.20", "address": "10.64.0.20"},
            },
        )
        with self.assertRaisesRegex(AuthenticatedPreviewError, "not allowlisted"):
            _target_config("arbitrary-host")
        with self.assertRaisesRegex(AuthenticatedPreviewError, "not allowlisted"):
            _target_config("dgx-spark-worker-02")

    def test_web_api_network_connection_is_one_bounded_docker_command(self) -> None:
        class Remote:
            command = None

            def run(self, command, timeout):
                self.command = command
                self.timeout = timeout
                return type("Result", (), {"returncode": 0, "stderr": "", "stdout": ""})()

        remote = Remote()
        _connect_web_to_api_network(remote, "teamaibox-auth-web")
        self.assertEqual(
            remote.command,
            (
                "docker",
                "network",
                "connect",
                "--alias",
                "teamaibox-auth-web",
                NETWORK,
                "teamaibox-auth-web",
            ),
        )
        self.assertEqual(remote.timeout, 30)

    def test_api_is_internal_only_and_reads_a_mounted_bootstrap(self) -> None:
        command = _api_command(
            API,
            "sha256:" + "a" * 64,
            "20260810-test-a1",
            "teamaibox-auth-secret-20260810-test-a1-bootstrap",
            "https://10.64.0.20:18443",
            stable=True,
        )
        rendered = " ".join(command)
        self.assertIn(f"--network {NETWORK}", rendered)
        self.assertNotIn("--publish", command)
        self.assertIn("PLATFORM_API_BOOTSTRAP_FILE=/run/bootstrap/bootstrap.json", command)
        self.assertIn("PLATFORM_API_PERSISTENCE=memory", command)
        self.assertNotIn("password", rendered.lower())

    def test_candidate_api_uses_only_the_protected_setup_token_boundary(self) -> None:
        command = _setup_api_command(
            "teamaibox-auth-api-candidate-20260812-test-a1",
            "sha256:" + "a" * 64,
            "20260812-test-a1",
            "teamaibox-auth-secret-20260812-test-a1-setup",
            "https://10.64.0.18:18444",
        )
        rendered = " ".join(command)
        self.assertIn(f"--network {NETWORK}", rendered)
        self.assertNotIn("--publish", command)
        self.assertIn("PLATFORM_API_SETUP_TOKEN_FILE=/run/setup/setup-token", command)
        self.assertIn("PLATFORM_API_PERSISTENCE=memory", command)
        self.assertNotIn("PLATFORM_API_BOOTSTRAP_FILE", rendered)
        self.assertNotIn("password", rendered.lower())

    def test_web_terminates_tls_on_the_non_masqueraded_edge(self) -> None:
        command = _web_command(
            "teamaibox-auth-web",
            "sha256:" + "b" * 64,
            "20260810-test-a1",
            "teamaibox-auth-secret-20260810-test-a1-tls",
            "https://10.64.0.20:18443",
            API,
            stable=True,
            port=18443,
        )
        rendered = " ".join(command)
        self.assertIn(f"--network {EDGE_NETWORK}", rendered)
        self.assertIn("--publish 0.0.0.0:18443:8443", rendered)
        self.assertIn("WEB_MODE=release", command)
        self.assertIn("WEB_TLS_KEY_FILE=/run/tls/web.key", command)
        self.assertNotIn("WEB_DEVELOPMENT_DEMO", rendered)

    def test_platform_api_image_is_digest_locked_and_non_root(self) -> None:
        dockerfile = (ROOT / "deploy/images/platform-api.Dockerfile").read_text(encoding="utf-8")
        self.assertIn("ARG NODE_IMAGE=docker.io/library/node@sha256:", dockerfile)
        self.assertIn("USER 1000:1000", dockerfile)
        self.assertIn('pnpm install --frozen-lockfile --ignore-scripts --prod', dockerfile)
        self.assertIn('ENTRYPOINT ["node", "/opt/teamaibox/apps/platform-api/server/appliance-main.mjs"]', dockerfile)
        self.assertNotIn("apt-get", dockerfile)
        for runtime_dependency in ("object-service", "scheduler", "source-gateway"):
            self.assertIn(f"services/{runtime_dependency} ./services/{runtime_dependency}", dockerfile)

    def test_platform_api_source_archive_contains_every_cross_workspace_runtime(self) -> None:
        from tools.deploy_spark_authenticated_preview import SOURCE_PATHS

        server = (ROOT / "apps/platform-api/server/platform-api.mjs").read_text(encoding="utf-8")
        for runtime_dependency in ("object-service", "scheduler", "source-gateway"):
            self.assertIn(f'../../../services/{runtime_dependency}/', server)
            self.assertIn(f"services/{runtime_dependency}", SOURCE_PATHS)
        main = (ROOT / "apps/platform-api/server/main.mjs").read_text(encoding="utf-8")
        self.assertIn("packages/persistence/src/postgres-database.mjs", main)
        self.assertIn("packages/persistence", SOURCE_PATHS)

    def test_offline_base_override_is_complete_and_run_scoped(self) -> None:
        self.assertIsNotNone(SAFE_IMAGE_ID.fullmatch("sha256:" + "c" * 64))
        for unsafe in ("node:latest", "sha256:abc", "sha256:" + "C" * 64):
            self.assertIsNone(SAFE_IMAGE_ID.fullmatch(unsafe))
        source = inspect.getsource(deploy)
        self.assertIn('f"teamaibox/preloaded-auth-node-runtime:{run_id}"', source)
        self.assertIn('("docker", "image", "rm", preloaded_base_alias)', source)
        self.assertIn("setup_token_path.unlink(missing_ok=True)", source)
        self.assertIn("_remove_volume(remote, setup_volume)", source)
        self.assertIn("_api_runtime_dependency_smoke(remote, candidate_api)", source)

    def test_secure_owner_setup_smoke_never_outputs_setup_or_recovery_material(self) -> None:
        source = (ROOT / "tools/secure_owner_setup_smoke.mjs").read_text(encoding="utf-8")
        self.assertIn('created.value.recoveryCodes.fill("[REDACTED]")', source)
        self.assertIn("recoveryCodesReturnedOnce: true", source)
        self.assertNotIn("recoveryCodes: created", source)

    def test_tls_leaf_is_bound_to_the_selected_target_address(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            _, chain, _, _ = _generate_tls(pathlib.Path(directory), "20260812-test-a1", "10.64.0.18")
            import subprocess
            inspected = subprocess.run(
                ["openssl", "x509", "-in", str(chain), "-noout", "-text"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
            self.assertIn("IP Address:10.64.0.18", inspected)
            self.assertNotIn("10.64.0.20", inspected)

    def test_evidence_paths_accept_repository_relative_and_reject_external_absolute_paths(self) -> None:
        output, reference = _repository_evidence_path(pathlib.Path("evidence/platform/auth-preview.json"))
        self.assertTrue(output.is_absolute())
        self.assertEqual(reference, "evidence/platform/auth-preview.json")
        import tempfile

        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(AuthenticatedPreviewError, "inside the repository"):
                _repository_evidence_path(pathlib.Path(directory) / "auth-preview.json")


if __name__ == "__main__":
    unittest.main()

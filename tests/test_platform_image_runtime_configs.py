from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class PlatformImageRuntimeConfigTests(unittest.TestCase):
    def test_production_image_contains_only_portable_startup_defaults(self):
        dockerfile = (ROOT / "deploy/images/platform-api.Dockerfile").read_text(encoding="utf-8")
        expected = (
            "built-in-applications.json",
            "plugin-import-policy.json",
            "plugin-sandbox-policy.json",
            "wireless-casting-control-plane.disabled.v1.json",
        )
        for destination in expected:
            with self.subTest(destination=destination):
                self.assertIn(f"./config/{destination}", dockerfile)
        self.assertNotIn("deploy/application-catalog-e2e/", dockerfile)
        self.assertNotIn("managed-node-endpoints.json", dockerfile)

    def test_installation_specific_configurations_are_mounted_not_baked_into_image(self):
        compose = (ROOT / "deploy/appliance/compose.yaml").read_text()
        applications = (ROOT / "deploy/appliance/applications.compose.yaml").read_text()
        maintenance = (ROOT / "deploy/appliance/maintenance.compose.yaml").read_text()
        self.assertIn("TEAMAIBOX_APPLIANCE_PUBLIC_CONFIG_DIR", compose)
        self.assertIn("target: /run/config/appliance", compose)
        self.assertIn("TEAMAIBOX_APPLIANCE_RUNTIME_ENV_FILE", applications)
        self.assertIn("PLATFORM_APPLICATION_ROUTES_FILE: /run/config/appliance/plugin-routes.json", applications)
        self.assertIn("TEAMAIBOX_MAINTENANCE_RUNTIME_CONFIG_FILE", maintenance)
        self.assertIn("PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE: /opt/teamaibox/config/maintenance-runtime.json", maintenance)

    def test_production_image_contains_digest_pinned_validator_runtime_without_host_install(self):
        dockerfile = (ROOT / "deploy/images/platform-api.Dockerfile").read_text(encoding="utf-8")
        self.assertIn(
            "docker.io/library/python@sha256:a116514e19457bcb7af7efe9c3dd0b9b71e85b317694e7882a1c52aa15a78134",
            dockerfile,
        )
        self.assertIn("FROM ${PYTHON_IMAGE} AS validator-runtime", dockerfile)
        self.assertIn("/usr/local/bin/python3.12", dockerfile)
        self.assertIn("/usr/local/lib/python3.12", dockerfile)

    def test_local_control_namespace_reaches_retained_application_and_phone_networks(self):
        compose = (ROOT / "deploy/appliance/protected-office.compose.yaml").read_text()
        self.assertIn("networks: [edge, control, data, compute-internal, plugin-ingress, phone-control]", compose)
        self.assertIn("name: plugin-ingress", compose)
        self.assertIn("TEAMAIBOX_PHONE_CONTROL_NETWORK", compose)
        self.assertIn("TEAMAIBOX_PHONE_CONTROL_NETWORK=", (ROOT / "deploy/appliance/appliance.env.example").read_text())

if __name__ == "__main__":
    unittest.main()

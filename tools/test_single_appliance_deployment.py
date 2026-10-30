"""Read-only checks for the single-appliance deployment boundary."""
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]
FILES = [ROOT / "deploy/compose/core.yaml"] + [ROOT / "deploy/appliance" / name for name in (
    "compose.yaml", "applications.compose.yaml", "protected-office.compose.yaml",
    "maintenance.compose.yaml")]


class SingleApplianceDeploymentTest(unittest.TestCase):
    def test_current_application_images_have_complete_source_contexts(self):
        # Product images build from the repository, not a chain of historical
        # per-machine patch images. Cross-stage COPY sources are build outputs.
        dockerfiles = [ROOT / "deploy/images" / name for name in (
            "platform-api.Dockerfile", "web.Dockerfile")]
        dockerfiles += sorted((ROOT / "deploy/appliance").glob("*-plugin.Dockerfile"))
        dockerfiles += [ROOT / "deploy/appliance" / name for name in (
            "object-service.Dockerfile", "messaging.Dockerfile")]
        for dockerfile in dockerfiles:
            with self.subTest(dockerfile=str(dockerfile.relative_to(ROOT))):
                text = dockerfile.read_text().replace("\\\n", " ")
                self.assertNotRegex(text, r"ARG (?:BASE_IMAGE|PLATFORM_PARENT)")
                for line in text.splitlines():
                    tokens = shlex.split(line)
                    if not tokens or tokens[0].upper() != "COPY":
                        continue
                    if any(token.startswith("--from=") for token in tokens[1:]):
                        continue
                    paths = [token for token in tokens[1:] if not token.startswith("--")]
                    for source in paths[:-1]:
                        self.assertTrue(list(ROOT.glob(source)),
                                        f"{dockerfile.relative_to(ROOT)}: missing COPY source {source}")

    def test_product_composition_preserves_applications_and_local_control(self):
        environment = dict(os.environ)
        for path in FILES:
            for key in re.findall(r"\$\{([A-Z0-9_]+)(?::[^}]*)?\}", path.read_text()):
                if key.endswith("IMAGE"):
                    value = "registry.validation.invalid/teamaibox/service@sha256:" + "a" * 64
                elif key.endswith("PORT") or key.endswith("GID"):
                    value = "9443"
                elif key.endswith("ORIGIN"):
                    value = "https://appliance.validation.invalid"
                elif key.endswith("FILE") or key.endswith("DIR") or key.endswith("ROOT"):
                    value = "/var/lib/teamaibox-validation/" + key.lower()
                else:
                    value = "local-validation"
                environment[key] = value
        environment["PLATFORM_APPLIANCE_NODE_ID"] = "11111111-1111-4111-8111-111111111111"
        environment["TEAMAIBOX_WEB_BIND_ADDRESS"] = "0.0.0.0"
        result = subprocess.run(["docker", "compose", "-f", str(ROOT / "deploy/appliance/production.compose.yaml"),
            "config", "--no-env-resolution", "--format", "json"], env=environment,
            cwd=ROOT, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        compose = json.loads(result.stdout)
        services = compose["services"]
        for application in ("messaging", "team-drive", "drawing", "ocr", "asr", "translation",
                            "virtual-phones", "virtual-computers", "wireless-casting"):
            self.assertIn(application + "-plugin", services)
        for service in ("postgres", "event-bus", "object-service", "messaging", "platform-api", "web"):
            self.assertIn(service, services)
        for service in ("node-agent", "appliance-gateway", "maintenance-controller"):
            self.assertEqual(services[service]["network_mode"], "service:platform-api")
            self.assertFalse(services[service].get("ports"))
        self.assertEqual(services["node-agent"]["environment"]["TEAMAIBOX_LISTEN_ADDRESS"], "127.0.0.1:9443")
        self.assertEqual(services["node-agent"]["environment"]["TEAMAIBOX_PHONES_CONFIG_FILE"], "/run/config/guests/phones.json")
        guest_mount=next(v for v in services['node-agent']['volumes'] if v['target']=='/run/config/guests')
        self.assertTrue(guest_mount['read_only'])
        self.assertEqual(guest_mount['source'],environment['TEAMAIBOX_GUEST_CONFIG_DIR'])
        for key in ('TEAMAIBOX_GUEST_DATA_ROOT','TEAMAIBOX_GUEST_CONTROL_ROOT','TEAMAIBOX_GUEST_MEDIA_ROOT','TEAMAIBOX_GUEST_ASSETS_ROOT','TEAMAIBOX_GUEST_RUNTIME_DIR'):
            self.assertTrue(any(v['source']==environment[key] and v['target']==environment[key] for v in services['node-agent']['volumes']))
        self.assertEqual(services["platform-api"]["environment"]["PLATFORM_APPLIANCE_AGENT_HOST"], "127.0.0.1")
        office = services["platform-api"]["environment"]
        self.assertEqual(office["PLATFORM_PROTECTED_OFFICE_SET_ID"], "office.baseline")
        self.assertEqual(office["PLATFORM_PROTECTED_OFFICE_SET_NODE_ID"], environment["PLATFORM_APPLIANCE_NODE_ID"])
        self.assertEqual(office["PLATFORM_APPLIANCE_PROTECTED_TARGET_POLICY_DIGEST"],
                         services["node-agent"]["environment"]["TEAMAIBOX_EXCLUSIVE_DRAIN_TARGETS_DIGEST"])
        for prefix in ("LOCAL_OPENAI", "DRAWING", "OCR", "ASR", "TRANSLATION", "EMBEDDING"):
            self.assertIn(office[prefix + "_WORKER_ID"], office[prefix + "_WORKER_ORIGIN"])
            self.assertEqual(office[prefix + "_WORKER_ID"], environment[prefix + "_WORKER_ID"])
        for old in ("PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_ID", "PLATFORM_PROTECTED_OFFICE_SET_BUNDLE_ROOT",
                    "PLATFORM_PROTECTED_OFFICE_SET_DEPLOYMENT_PLAN_FILE", "PLATFORM_PROTECTED_OFFICE_SET_PROBE_JOB_ID"):
            self.assertNotIn(old, office)
        self.assertIn("PLATFORM_MAINTENANCE_RUNTIME_CONFIG_FILE", office)
        self.assertIn("PLATFORM_PROTECTED_OFFICE_SET_RESTART_POLICY_DIGEST", office)
        self.assertNotIn("protected_office_set_v5_bundle", compose.get("volumes", {}))
        self.assertNotIn("protected_office_set_probe_credential", compose.get("secrets", {}))
        for removed in ("node-ca-signer", "node-federation-gateway", "catalog-health", "member-seed"):
            self.assertNotIn(removed, services)
        for path in FILES:
            self.assertNotRegex(path.read_text(), r"192\.168\.10\.|TEAMAIBOX_FLEET_|PLATFORM_MANAGED_NODE_|node-federation")

    def test_api_image_does_not_bake_installation_configuration(self):
        text = (ROOT / "deploy/images/platform-api.Dockerfile").read_text()
        self.assertIn("server/appliance-main.mjs", text)
        self.assertNotIn("deploy/application-catalog-e2e/", text)
        self.assertNotIn("managed-node", text)
        self.assertNotIn("tools/protected_office_set_", text)
        self.assertEqual(list((ROOT / "deploy/managed-node-production").glob("*")), [])
        self.assertEqual([path for path in (ROOT / "services/node-ca-signer").rglob("*") if path.is_file()], [])


if __name__ == "__main__":
    unittest.main()

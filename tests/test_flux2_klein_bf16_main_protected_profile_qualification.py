from __future__ import annotations

from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from tools import run_flux2_klein_bf16_main_protected_profile_qualification as qualification
from tools import validate_flux2_klein_bf16_main_protected_profile_qualification as validator
from tools.run_flux2_klein_bf16_main_protected_profile_qualification import (
    HISTORICAL_PARENT,
    aggregate_memory,
    build_profile_document,
    claim_exact_run,
    declared_target_identity,
    definitely_missing,
    launch_command,
    load_config,
    port_is_listening,
    profile_package,
    redact,
    release_exact_run_claim,
    registration_preflight,
    registration_sql,
    registration_state,
    validate_historical_parent_payload,
    validate_replication_parent_payload,
)
from tools.run_spark_model_baseline import canonical_digest


ROOT = Path(__file__).resolve().parents[1]


def load_worker_module():
    path = ROOT / "services/drawing-worker/flux2_bf16_protected_server.py"
    name = "teamaibox_flux2_bf16_protected_server_test"
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError("protected Worker module could not be loaded")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def replication_fixture(config: dict) -> dict:
    manifest = {"files": [], "totalBytes": config["artifact"]["totalBytes"]}
    value = {
        "schemaVersion": 1,
        "runnerId": "teamaibox.flux2-klein-bf16-main-artifact-replication.v1",
        "runId": config["artifact"]["replicationRunId"],
        "status": "passed",
        "target": {
            **config["target"], "volume": config["artifact"]["targetVolume"],
            "imageTag": config["engine"]["targetImageTag"],
        },
        "artifact": {
            "sourceManifest": manifest, "targetManifest": manifest,
            "artifactDigest": config["artifact"]["weightsArtifactDigest"],
            "weightsArtifactDigest": config["artifact"]["weightsArtifactDigest"],
            "byteIdentity": True,
        },
        "runtimeImage": {
            "source": {"imageId": config["engine"]["imageId"]},
            "target": {"imageId": config["engine"]["imageId"]},
            "byteIdentity": True, "importPerformed": True,
            "targetReference": config["engine"]["targetImageTag"],
        },
        "claimBoundary": {
            "artifactReplicated": True, "runtimeImageReplicated": True,
            "profileDeployed": False, "aggregateManifestUpdated": False,
            "task21_3Complete": False,
        },
        "failure": None,
    }
    value["evidenceDigest"] = canonical_digest(value)
    return value


def memory_cycle(*, gpu: int, current: int, peak: int, allocated: int,
                 reserved: int, before: int, after: int) -> dict:
    delta = max(0, before - after)
    observed = max(gpu, current, peak, allocated, reserved, delta)
    headroom = 256 * 1024**2
    settled_psi = {"someAvg10": 0.0, "someTotal": 0,
                   "fullAvg10": 0.0, "fullTotal": 0}
    return {
        "nvidiaProcessBytes": gpu,
        "containerCurrentBytes": current,
        "containerPeakBytes": peak,
        "cudaPeakAllocatedBytes": allocated,
        "cudaPeakReservedBytes": reserved,
        "hostMemoryAvailableBeforeBytes": before,
        "hostMemoryAvailableAfterBytes": after,
        "minimumHostMemoryAvailableBytes": after,
        "hostObservedDeltaBytes": delta,
        "unifiedObservedBytes": observed,
        "accountingHeadroomBytes": headroom,
        "accountedAdmissionBytes": observed + headroom,
        "accountingPolicy": "continuous-maximum-plus-fixed-headroom-no-overlap-sum",
        "doubleCountingAvoided": True,
        "continuousSampling": True, "sampleIntervalSeconds": 2, "sampleCount": 2,
        "transientProcessExitRetries": 0,
        "sampleSetDigest": "sha256:" + "d" * 64, "gpuPidOwnershipExact": True,
        "exclusiveGpuOwnershipRequired": True, "nonTargetGpuProcessCount": 0,
        "oomEventsBefore": {"oom": 0, "oom_kill": 0},
        "oomEventsAfter": {"oom": 0, "oom_kill": 0},
        "oomEventDelta": {"oom": 0, "oom_kill": 0},
        "maximumPsiFullAvg10": 0.0,
        "psiBefore": settled_psi,
        "psiAdmission": {
            "settled": True, "maximumAllowedFullAvg10": 1.0,
            "timeoutSeconds": 180, "pollIntervalSeconds": 2,
            "requiredConsecutiveSamples": 2, "observationCount": 2,
            "initialObservation": dict(settled_psi),
            "settledObservation": dict(settled_psi),
            "waitMilliseconds": 2000,
        },
    }


def runtime_snapshot(config: dict, run_id: str, started_at: str) -> dict:
    runtime = config["runtime"]
    return {
        "containerId": "a" * 64, "imageId": config["engine"]["imageId"],
        "configuredImage": config["engine"]["targetImageTag"],
        "running": True, "health": "healthy", "oomKilled": False,
        "startedAt": started_at, "restartCount": 0,
        "user": runtime["processIdentity"], "readOnly": True, "privileged": False,
        "networkMode": runtime["networkName"], "networks": [runtime["networkName"]],
        "portBindings": {"8000/tcp": [{"HostIp": "127.0.0.1", "HostPort": "19104"}]},
        "memoryBytes": runtime["hardMemoryBytes"],
        "memoryReservationBytes": runtime["memoryReservationBytes"],
        "nanoCpus": 12_000_000_000, "pidsLimit": 1024,
        "shmSizeBytes": 2 * 1024**3,
        "deviceRequests": [{"Count": -1, "Capabilities": [["gpu"]]}],
        "restartPolicy": runtime["restartPolicy"], "capDrop": ["ALL"],
        "securityOpt": ["no-new-privileges"],
        "tmpfs": {"/tmp": "rw,exec,nosuid,nodev,size=8g,uid=65532,gid=65532,mode=1770"},
        "labels": {
            "com.teamaibox.run-id": run_id, "com.teamaibox.managed": "true",
            "com.teamaibox.component": "drawing-flux2-klein-bf16-worker",
            "com.teamaibox.profile-key": config["profileKey"],
            "com.teamaibox.placement-class": "protected-resident",
            "com.teamaibox.ordinary-drain-allowed": "false",
            "com.teamaibox.idle-unload": "false",
        },
        "environment": runtime["runtimeEnvironment"], "entrypoint": ["python3"],
        "command": ["/runtime/flux2_bf16_protected_server.py"],
        "healthcheck": {
            "Test": ["CMD-SHELL", "python3 -c \"import pathlib,urllib.request;"
                     "t=pathlib.Path('/run/secrets/auth/provider.token').read_text().strip();"
                     "q=urllib.request.Request('http://127.0.0.1:8000/health',"
                     "headers={'Authorization':'Bearer '+t});"
                     "urllib.request.urlopen(q,timeout=3).read()\""],
            "Interval": 10_000_000_000, "Timeout": 5_000_000_000,
            "Retries": 30, "StartPeriod": 1_200_000_000_000,
        },
        "mounts": [
            {"type": "volume", "name": config["artifact"]["targetVolume"],
             "source": "/var/lib/docker/volumes/model/_data", "destination": "/model",
             "rw": False},
            {"type": "volume", "name": config["artifact"]["runtimeBundleVolume"],
             "source": "/var/lib/docker/volumes/runtime/_data", "destination": "/runtime",
             "rw": False},
            {"type": "volume", "name": config["runtime"]["authenticationVolume"],
             "source": "/var/lib/docker/volumes/auth/_data",
             "destination": "/run/secrets/auth", "rw": False},
            {"type": "volume", "name": config["runtime"]["offloadVolume"],
             "source": "/var/lib/docker/volumes/offload/_data",
             "destination": config["runtime"]["offloadMountPath"], "rw": True},
        ],
    }


def protocol_fixture(model: str, cycle: int) -> dict:
    return {
        "passed": True, "cycle": cycle, "model": model,
        "modelsEndpoint": {"httpStatus": 200, "ids": [model]},
        "generation": {"passed": True, "output": {
            "bytes": 1000, "sha256": "sha256:" + "f" * 64,
            "width": 512, "height": 512, "meanChannelVariance": 100.0,
        }, "wallClockMilliseconds": 30_000, "maximumAllowedMilliseconds": 120_000},
        "cancellation": {"passed": True, "ownerBound": True,
                         "foreignOwnerDeniedHttpStatus": 403,
                         "lateCancellationLinearized": True},
        "postCancellationRecovery": {
            "passed": True, "httpStatus": 200,
            "output": {"sha256": "sha256:" + "f" * 64},
            "matchesInitialGeneration": True,
        },
        "concurrency": {"passed": True, "maximumConcurrentRequests": 1,
                        "rejectionHttpStatus": 429},
        "generationOnly": {"passed": True, "editHttpStatus": 400},
        "protectedResidency": {"passed": True, "unloadHttpStatus": 409,
                               "warmAfterProbe": True},
        "authentication": {"passed": True, "bearerRequired": True,
                           "unauthenticatedHttpStatus": 401,
                           "credentialRetained": False},
        "watchdog": {"wallClockTimeoutSeconds": 600, "fatalCudaReadiness": True},
        "kvCache": {"applicability": "not-applicable-image-diffusion-pipeline",
                    "explicit_bytes": None},
        "contentRetained": False, "syntheticPromptsOnly": True,
    }


class Flux2KleinBF16MainProtectedProfileQualificationTest(unittest.TestCase):
    def setUp(self) -> None:
        self.config = load_config()
        self.parent = validate_replication_parent_payload(
            replication_fixture(self.config), self.config
        )
        self.parent.update({
            "path": qualification.REPLICATION_PARENT.relative_to(ROOT).as_posix(),
            "fileSha256": "sha256:" + "a" * 64,
            "offlineImmutableParentValidation": True,
            "liveAuxiliaryDependency": False,
        })

    def test_config_is_truthful_bf16_main_box_protected_resident(self) -> None:
        self.assertEqual(self.config["profileId"],
                         "06c9542e-4bf3-5f4f-a41e-c7768398e2ea")
        self.assertEqual(self.config["profileKey"],
                         "drawing.flux2-klein-4b.bf16.main-protected.v2")
        self.assertEqual(self.config["lifecycleEventId"],
                         "ed5595ea-b4d0-5d34-a806-c7a5df69e178")
        self.assertEqual(self.config["placementRevisionId"],
                         "ee1b92e2-b4b3-5a51-b7cd-621e66e4e0ba")
        self.assertEqual(self.config["successorOf"], {
            "profileId": "b6d9b000-21f8-51d3-b726-751d87dc234b",
            "profileKey": "drawing.flux2-klein-4b.bf16.main-protected.v1",
            "runId": (
                "flux2-klein-bf16-main-protected-profile-qualification-"
                "20260904-a14"
            ),
            "evidenceDigest": (
                "sha256:b4c71c5eec92e3f1b8dc35692b41301e929239f4c75b1bd10581cab19aac6748"
            ),
            "reason": "strict-validator-postgresql-function-argument-limit",
        })
        self.assertEqual(self.config["target"]["ssh"], "operator@10.64.0.20")
        self.assertEqual(self.config["target"]["nodeRole"], "main-box")
        self.assertEqual(self.config["placementClass"], "protected-resident")
        self.assertEqual(self.config["source"]["model"], "black-forest-labs/FLUX.2-klein-4B")
        self.assertEqual(
            self.config["source"]["revision"],
            "e7b7dc27f91deacad38e78976d1f2b499d76a294",
        )
        self.assertEqual(self.config["precision"]["databaseValue"], "bf16")
        self.assertEqual(self.config["precision"]["quantization"], "none")
        self.assertNotIn("nvfp4", json.dumps(self.config).lower())
        runtime = self.config["runtime"]
        self.assertEqual(runtime["containerName"],
                         "teamaibox-flux2-klein-bf16-main-protected-v2")
        self.assertEqual(runtime["networkName"],
                         "teamaibox-flux2-klein-bf16-main-protected-net-v2")
        self.assertEqual(runtime["authenticationVolume"],
                         "teamaibox-flux2-klein-bf16-main-protected-auth-v2")
        self.assertEqual(runtime["offloadVolume"],
                         "teamaibox-flux2-klein-bf16-main-protected-offload-v2")
        self.assertEqual(self.config["artifact"]["runtimeBundleVolume"],
                         "teamaibox-flux2-klein-bf16-main-protected-runtime-v2")
        self.assertTrue(runtime["warm"])
        self.assertFalse(runtime["idleUnload"])
        self.assertFalse(runtime["ordinaryDrainAllowed"])
        self.assertEqual(runtime["hardMemoryBytes"], 8_809_373_696)
        self.assertEqual(runtime["memoryReservationBytes"], runtime["hardMemoryBytes"])
        self.assertEqual(runtime["protectedSlotAdmissionBytes"], 9_077_809_152)
        self.assertEqual(
            runtime["hardMemoryBytes"]
            + self.config["qualificationControl"]["memoryAccountingHeadroomBytes"],
            runtime["protectedSlotAdmissionBytes"],
        )
        self.assertEqual(runtime["minimumCoreServiceReserveBytes"], 32 * 1024**3)
        self.assertEqual(runtime["minimumTransientMarginBytes"], 16 * 1024**3)
        self.assertEqual(runtime["minimumProtectedStartAvailableBytes"], 60_617_416_704)
        self.assertEqual(runtime["minimumStandaloneQualificationAvailableBytes"], 96 * 1024**3)
        budget = self.config["protectedOfficeSetBudget"]
        self.assertEqual(budget["preFluxAccountedBytes"], 59_641_667_584)
        self.assertEqual(budget["preFluxAccountedBytes"] + runtime["protectedSlotAdmissionBytes"],
                         budget["modelResidentCeilingBytes"])
        self.assertEqual(runtime["networkSubnet"], "192.0.2.0/30")
        self.assertEqual(runtime["networkGateway"], "192.0.2.1")
        self.assertEqual(runtime["networkIsolation"], {
            "kind": "loopback-published-no-masquerade-bridge",
            "internal": False,
            "enableInterContainerCommunication": False,
            "enableIpMasquerade": False,
            "hostBindingAddress": "127.0.0.1",
            "externalEgressAllowed": False,
        })
        self.assertNotIn("minimumAvailableAfterDrainBytes", runtime)
        self.assertNotIn("admissionGiB", runtime)
        control = self.config["qualificationControl"]
        self.assertEqual(control["memoryPsiSettleTimeoutSeconds"], 180)
        self.assertEqual(control["memoryPsiSettlePollSeconds"], 2)
        self.assertEqual(control["memoryPsiSettleConsecutiveSamples"], 2)

    def test_replication_parent_binds_exact_bf16_bytes_image_and_target(self) -> None:
        self.assertEqual(self.parent["artifactDigest"],
                         self.config["artifact"]["weightsArtifactDigest"])
        self.assertEqual(self.parent["imageId"], self.config["engine"]["imageId"])
        self.assertEqual(self.parent["volume"], self.config["artifact"]["targetVolume"])
        drifted = deepcopy(replication_fixture(self.config))
        drifted["runtimeImage"]["target"]["imageId"] = "sha256:" + "0" * 64
        unsigned = dict(drifted)
        unsigned.pop("evidenceDigest")
        drifted["evidenceDigest"] = canonical_digest(unsigned)
        with self.assertRaisesRegex(Exception, "runtime image drifted"):
            validate_replication_parent_payload(drifted, self.config)

    def test_old_smoke_is_measurement_only_not_bf16_identity_authority(self) -> None:
        value = json.loads(HISTORICAL_PARENT.read_text(encoding="utf-8"))
        facts = validate_historical_parent_payload(value, self.config)
        self.assertEqual(facts["role"], "historical-bf16-measurement-only")
        self.assertFalse(facts["identityAuthority"])
        self.assertEqual(facts["runId"], "flux2-klein-runtime-smoke-20260831-a6")

    def test_profile_package_digest_is_stable_and_separate_from_weights(self) -> None:
        first = profile_package(self.config, self.parent)
        second = profile_package(self.config, self.parent)
        self.assertEqual(first, second)
        self.assertNotEqual(first["digest"], self.config["artifact"]["weightsArtifactDigest"])
        self.assertEqual(first["document"]["weights"]["digest"],
                         self.config["artifact"]["weightsArtifactDigest"])
        self.assertEqual(first["document"]["engine"]["imageId"],
                         self.config["engine"]["imageId"])
        self.assertEqual(first["document"]["precision"]["databaseValue"], "bf16")
        self.assertEqual(first["document"]["runtimeServer"]["path"],
                         "services/drawing-worker/flux2_bf16_protected_server.py")

    def test_launch_is_hardened_loopback_warm_generation_only_and_exact_remainder(self) -> None:
        command = launch_command(
            self.config,
            "flux2-klein-bf16-main-protected-profile-qualification-20260904-a1",
        )
        joined = " ".join(command)
        for token in (
            "--publish 127.0.0.1:19104:8000", "--read-only", "--cap-drop ALL",
            "no-new-privileges", "--memory 8809373696",
            "--memory-reservation 8809373696",
            "--restart unless-stopped", "com.teamaibox.placement-class=protected-resident",
            "--network teamaibox-flux2-klein-bf16-main-protected-net-v2",
            "com.teamaibox.ordinary-drain-allowed=false",
            "com.teamaibox.idle-unload=false", "TEAMAIBOX_DRAWING_IDLE_UNLOAD_SECONDS=0",
            "TEAMAIBOX_DRAWING_MAX_CONCURRENCY=1",
            "TEAMAIBOX_DRAWING_MEMORY_STRATEGY=leaf-level-group-offload-to-dedicated-disk-volume-with-resident-vae",
            "src=teamaibox-flux2-klein-bf16-main-protected-offload-v2,dst=/offload",
            "/runtime/flux2_bf16_protected_server.py",
        ):
            self.assertIn(token, joined)
        self.assertNotIn("--network host", joined)
        self.assertNotIn("--network bridge", joined)
        self.assertNotIn("96g", joined)
        self.assertNotIn("18g", joined)

    def test_port_detection_matches_only_the_local_listener_column(self) -> None:
        output = "LISTEN 0 4096 127.0.0.1:19104 0.0.0.0:*\n"
        self.assertTrue(port_is_listening(output, 19104))
        self.assertFalse(port_is_listening(output, 1910))
        self.assertFalse(port_is_listening("LISTEN 0 4096 127.0.0.1:9 0.0.0.0:19104\n", 19104))

    def test_unified_memory_uses_maximum_of_overlap_not_sum(self) -> None:
        first = memory_cycle(
            gpu=12, current=8, peak=9, allocated=11, reserved=13, before=100, after=94,
        )
        second = memory_cycle(
            gpu=14, current=7, peak=10, allocated=12, reserved=15, before=100, after=91,
        )
        value = aggregate_memory((first, second))
        self.assertEqual(value["admissionBytes"], 15 + 256 * 1024**2)
        self.assertNotEqual(value["admissionBytes"], 14 + 10 + 12 + 15 + 9)
        self.assertTrue(value["doubleCountingAvoided"])
        self.assertEqual(value["minimumHostMemoryAvailableBytes"], 91)

    def test_exact_64_gib_office_set_remainder_is_fail_closed(self) -> None:
        within = aggregate_memory((
            memory_cycle(gpu=7 * 1024**3, current=6 * 1024**3,
                         peak=7 * 1024**3, allocated=7 * 1024**3,
                         reserved=7 * 1024**3, before=64 * 1024**3,
                         after=57 * 1024**3),
            memory_cycle(gpu=7 * 1024**3, current=6 * 1024**3,
                         peak=7 * 1024**3, allocated=7 * 1024**3,
                         reserved=7 * 1024**3, before=64 * 1024**3,
                         after=57 * 1024**3),
        ))
        validator.validate_memory(within, self.config)
        over = deepcopy(within)
        over["observedPeakBytes"] = self.config["runtime"]["protectedSlotAdmissionBytes"]
        over["nvidiaProcessPeakBytes"] = over["observedPeakBytes"]
        over["admissionBytes"] = (
            over["observedPeakBytes"] + over["accountingHeadroomBytes"]
        )
        with self.assertRaisesRegex(Exception, "64 GiB"):
            validator.validate_memory(over, self.config)

    def test_profile_document_uses_package_unique_key_and_explicit_kv_na(self) -> None:
        package = profile_package(self.config, self.parent)
        historical = validate_historical_parent_payload(
            json.loads(HISTORICAL_PARENT.read_text(encoding="utf-8")), self.config
        )
        memory = aggregate_memory((
            memory_cycle(gpu=10, current=8, peak=9, allocated=10, reserved=11,
                         before=64 * 1024**3, after=63 * 1024**3),
            memory_cycle(gpu=11, current=8, peak=9, allocated=10, reserved=12,
                         before=64 * 1024**3, after=63 * 1024**3),
        ))
        runtime = {"containerId": "a" * 64, "coldStartMs": 1, "restartReadyMs": 1}
        run_id = "flux2-klein-bf16-main-protected-profile-qualification-20260904-a1"
        document = build_profile_document(
            self.config, self.parent, historical, package, runtime, memory, run_id,
            "2026-09-04T00:00:00.000Z",
        )
        self.assertEqual(document["artifactDigest"], package["digest"])
        self.assertNotEqual(document["artifactDigest"],
                            self.config["artifact"]["weightsArtifactDigest"])
        self.assertEqual(document["artifacts"][0]["role"], "weights")
        self.assertEqual(document["artifacts"][0]["digest"],
                         self.config["artifact"]["weightsArtifactDigest"])
        self.assertEqual(document["precision"], "bf16")
        self.assertEqual(document["quantizationRecipe"]["scheme"], "none")
        self.assertEqual(document["extensions"]["kvCache"]["applicability"],
                         "not-applicable-image-diffusion-pipeline")
        self.assertIsNone(document["extensions"]["kvCache"]["explicitBytes"])

    def test_registration_is_one_final_transaction_after_all_runtime_checks(self) -> None:
        package = profile_package(self.config, self.parent)
        historical = validate_historical_parent_payload(
            json.loads(HISTORICAL_PARENT.read_text(encoding="utf-8")), self.config
        )
        memory = aggregate_memory((
            memory_cycle(gpu=10, current=8, peak=9, allocated=10, reserved=11,
                         before=64 * 1024**3, after=63 * 1024**3),
            memory_cycle(gpu=11, current=8, peak=9, allocated=10, reserved=12,
                         before=64 * 1024**3, after=63 * 1024**3),
        ))
        runtime = {"containerId": "a" * 64, "coldStartMs": 1, "restartReadyMs": 1}
        run_id = "flux2-klein-bf16-main-protected-profile-qualification-20260904-a1"
        document = build_profile_document(
            self.config, self.parent, historical, package, runtime, memory, run_id,
            "2026-09-04T00:00:00.000Z",
        )
        sql = registration_sql(
            self.config, document, "1" * 64, package["digest"], memory,
            {"cycles": 2},
            {"nodeGroupId": self.config["target"]["nodeGroupId"],
             "maintenanceGeneration": 1}, run_id,
        )
        self.assertEqual(sql.count("BEGIN;"), 1)
        self.assertEqual(sql.count("COMMIT;"), 1)
        for table in (
            "compute.model_profiles", "compute.model_profile_registrations",
            "compute.model_profile_lifecycle_events",
            "compute.model_profile_placement_revisions",
        ):
            self.assertIn("INSERT INTO " + table, sql)
        self.assertIn(package["digest"], sql)
        self.assertIn(self.config["artifact"]["weightsArtifactDigest"], json.dumps(document))
        runner = (ROOT / "tools/run_flux2_klein_bf16_main_protected_profile_qualification.py").read_text()
        self.assertLess(runner.index("second_protocol, second_memory = run_probe_with_memory"),
                        runner.index("query(registration_sql("))
        self.assertLess(runner.index("version = remote"), runner.index("query(registration_sql("))

    def test_registration_preflight_rejects_occupied_identity_before_mutation(self) -> None:
        package = profile_package(self.config, self.parent)
        run_id = "flux2-klein-bf16-main-protected-profile-qualification-20260904-a1"
        with patch.object(qualification, "query",
                          return_value=["true|true|true|true|true|true"]):
            facts = registration_preflight(self.config, package["digest"], run_id)
        self.assertTrue(all(facts.values()))
        with patch.object(qualification, "query",
                          return_value=["true|false|true|true|true|true"]):
            with self.assertRaisesRegex(Exception, "identity is occupied"):
                registration_preflight(self.config, package["digest"], run_id)
        runner = (ROOT / "tools/run_flux2_klein_bf16_main_protected_profile_qualification.py").read_text()
        run_source = runner[runner.index("def run(run_id:"):]
        self.assertLess(run_source.index('report["registrationPreflight"] = registration_preflight'),
                        run_source.index("ledger = ensure_ledger_volume(config)"))

    def test_probe_covers_real_generation_cancel_concurrency_and_residency(self) -> None:
        source = (ROOT / "tools/flux2_klein_bf16_main_protected_probe.py").read_text()
        for token in (
            '"/v1/images/generations"', '"response_format": "b64_json"',
            "ThreadPoolExecutor(max_workers=2)", '"active_jobs"',
            '"maximum_concurrency_exceeded"', '"worker_cancelled"',
            '"/v1/images/edits"', '"/v1/models/unload"',
            '"protected_resident_unload_forbidden"', '"contentRetained": False',
        ):
            self.assertIn(token, source)
        self.assertNotIn('"b64_json": encoded', source)

    def test_server_is_warm_generation_only_and_has_no_idle_unloader(self) -> None:
        source = (ROOT / "services/drawing-worker/flux2_bf16_protected_server.py").read_text()
        for token in (
            "Flux2KleinPipeline.from_pretrained", 'torch_dtype=torch.bfloat16',
            "apply_group_offloading", "offload_to_disk_path",
            "threading.BoundedSemaphore(value=1)",
            '"operations": ["images.generations"]',
            '"protected_resident_unload_forbidden"', "IDLE_UNLOAD_SECONDS == 0",
            "load_pipeline()", "serve_forever()",
        ):
            self.assertIn(token, source)
        self.assertNotIn("idle_unload_loop", source)
        self.assertNotIn('pipeline.to("cuda")', source)
        self.assertNotIn("PIPELINE = None\n            ", source)

    def test_worker_accepts_the_exact_distilled_snapshot_metadata(self) -> None:
        worker = load_worker_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "transformer").mkdir()
            (root / "text_encoder").mkdir()
            (root / "vae").mkdir()
            (root / "model_index.json").write_text(json.dumps({
                "_class_name": "Flux2KleinPipeline", "is_distilled": True,
            }), encoding="utf-8")
            (root / "transformer/diffusion_pytorch_model.safetensors").touch()
            (root / "text_encoder/model.safetensors.index.json").touch()
            (root / "vae/diffusion_pytorch_model.safetensors").touch()
            with patch.object(worker, "MODEL_ROOT", root):
                self.assertTrue(worker.snapshot_ready())
            metadata = json.loads((root / "model_index.json").read_text(encoding="utf-8"))
            metadata["is_distilled"] = False
            (root / "model_index.json").write_text(json.dumps(metadata), encoding="utf-8")
            with patch.object(worker, "MODEL_ROOT", root):
                self.assertFalse(worker.snapshot_ready())

    def test_wait_healthy_fails_fast_on_restart_loop(self) -> None:
        value = {"running": True, "health": "starting", "restartCount": 1}
        diagnostic = subprocess.CompletedProcess([], 0, "snapshot failure", "")
        with patch.object(qualification, "snapshot", return_value=value), patch.object(
            qualification, "remote_result", return_value=diagnostic,
        ):
            with self.assertRaisesRegex(Exception, "restarted before ready"):
                qualification.wait_healthy("exact-worker", timeout_seconds=60)

    def test_pre_inference_memory_sample_allows_zero_torch_cuda_allocation(self) -> None:
        responses = ["PID\n123\n", "123, 170\n"]
        with patch.object(qualification, "remote", side_effect=responses), patch.object(
            qualification, "http_health", return_value={
                "fatal_cuda": False, "accepting": True,
                "cuda_memory": {"peak_allocated_bytes": 0, "peak_reserved_bytes": 0},
            },
        ), patch.object(
            qualification, "cgroup_value", side_effect=[1024, 2048],
        ), patch.object(
            qualification, "mem_available", return_value=96 * 1024**3,
        ), patch.object(
            qualification, "cgroup_memory_events", return_value={"oom": 0, "oom_kill": 0},
        ), patch.object(
            qualification, "memory_psi", return_value={
                "someAvg10": 0.0, "someTotal": 0,
                "fullAvg10": 0.0, "fullTotal": 0,
            },
        ):
            sample = qualification._memory_sample("exact-worker", "a" * 64, 19104)
        self.assertEqual(sample["cudaPeakAllocatedBytes"], 0)
        self.assertEqual(sample["cudaPeakReservedBytes"], 0)
        self.assertEqual(sample["gpuProcessIds"], [123])

    def test_memory_psi_settling_keeps_threshold_and_requires_consecutive_samples(self) -> None:
        observations = [
            {"someAvg10": 1.4, "someTotal": 1, "fullAvg10": 1.4, "fullTotal": 1},
            {"someAvg10": 0.9, "someTotal": 2, "fullAvg10": 0.9, "fullTotal": 2},
            {"someAvg10": 0.8, "someTotal": 3, "fullAvg10": 0.8, "fullTotal": 3},
        ]
        with patch.object(qualification, "memory_psi", side_effect=observations), patch.object(
            qualification.time, "sleep",
        ) as sleep, patch.object(
            qualification.time, "monotonic", side_effect=[100.0, 104.0],
        ):
            value = qualification.wait_for_memory_psi_settle(self.config)
        self.assertTrue(value["settled"])
        self.assertEqual(value["maximumAllowedFullAvg10"], 1.0)
        self.assertEqual(value["observationCount"], 3)
        self.assertEqual(value["initialObservation"]["fullAvg10"], 1.4)
        self.assertEqual(value["settledObservation"]["fullAvg10"], 0.8)
        self.assertEqual(value["waitMilliseconds"], 4000)
        self.assertEqual(sleep.call_count, 2)

    def test_probe_failure_retains_redacted_diagnostic(self) -> None:
        token_file = "/var/lib/docker/volumes/exact/_data/provider.token"
        diagnostic = subprocess.CompletedProcess(
            [], 1, "", "Authorization: Bearer secret-token pipeline exploded",
        )
        with patch.object(qualification, "remote_result", return_value=diagnostic):
            with self.assertRaisesRegex(Exception, "pipeline exploded") as raised:
                qualification.run_probe(self.config, "/tmp/exact-probe.py", 1, token_file)
        self.assertNotIn("secret-token", str(raised.exception))

    def test_failure_runtime_diagnostic_is_exact_bounded_and_redacted(self) -> None:
        exact_id = "a" * 64
        observed = runtime_snapshot(
            self.config,
            "flux2-klein-bf16-main-protected-profile-qualification-20260904-a8",
            "2026-09-04T00:00:00Z",
        )
        observed["containerId"] = exact_id
        diagnostic = subprocess.CompletedProcess(
            [], 0, "Authorization: Bearer secret-token\n" + "x" * 20_000, "",
        )
        with patch.object(qualification, "snapshot", return_value=observed), patch.object(
            qualification, "remote_result", return_value=diagnostic,
        ):
            value = qualification.failure_runtime_diagnostic("exact-worker", exact_id)
        self.assertTrue(value["identityMatched"])
        self.assertTrue(value["logsCollected"])
        self.assertNotIn("secret-token", value["redactedLogTail"])
        self.assertLessEqual(len(value["redactedLogTail"]), 16_384)

        other = dict(observed)
        other["containerId"] = "b" * 64
        with patch.object(qualification, "snapshot", return_value=other), patch.object(
            qualification, "remote_result",
        ) as remote_logs:
            mismatch = qualification.failure_runtime_diagnostic("exact-worker", exact_id)
        self.assertFalse(mismatch["identityMatched"])
        self.assertFalse(mismatch["logsCollected"])
        remote_logs.assert_not_called()

    def test_worker_failure_diagnostic_redacts_credentials_without_prompt_logging(self) -> None:
        worker = load_worker_module()
        value = worker.safe_error_diagnostic(RuntimeError(
            "Authorization: Bearer secret-token --password cli-secret "
            "https://u:uri-secret@example.test"
        ))
        encoded = json.dumps(value)
        for secret in ("secret-token", "cli-secret", "uri-secret"):
            self.assertNotIn(secret, encoded)
        self.assertEqual(value["classification"], "request-failed")

    def test_worker_diagnostic_keeps_call_sites_without_code_or_frame_locals(self) -> None:
        worker = load_worker_module()
        private_prompt = "PRIVATE_REQUEST_MUST_NOT_BE_LOGGED"
        try:
            raise RuntimeError("CUDA operation not permitted")
        except RuntimeError as error:
            value = worker.safe_error_diagnostic(error)
        self.assertEqual(value['classification'], 'cuda-fatal')
        self.assertEqual(set(value['frames'][-1]), {'file', 'line', 'function'})
        self.assertNotIn(private_prompt, json.dumps(value))
        self.assertNotIn('/', value['frames'][-1]['file'])

    def test_worker_security_and_failure_recovery_are_fail_closed(self) -> None:
        server = (ROOT / "services/drawing-worker/flux2_bf16_protected_server.py").read_text()
        probe = (ROOT / "tools/flux2_klein_bf16_main_protected_probe.py").read_text()
        for token in (
            "secrets.compare_digest", "X-TeamAIBox-Owner".lower(), "job_owner_mismatch",
            "_commit_terminal", "_wall_clock_watchdog", "os._exit(70)",
            "request.settimeout", "MAX_SERVER_THREADS", "request_queue_size = 8",
            "fatal_cuda", "torch.cuda.synchronize()",
            "os.O_NOFOLLOW", "st_nlink == 1",
            "non-finite diffusion latents", "non-finite decoded image tensor",
            'output_type="pt"', "pt_to_numpy(postprocessed)", "numpy_to_pil(",
            'pipeline.vae.to(device=torch.device("cuda"), dtype=torch.bfloat16)',
            '"inference_metrics"',
        ):
            self.assertIn(token, server.lower() if token == "x-teamaibox-owner" else server)
        for token in ("worker_unauthorized", "job_owner_mismatch",
                      "lateCancellationLinearized", "--token-file", "--owner-id"):
            self.assertIn(token, probe)

    def test_worker_bearer_is_one_owner_only_regular_file(self) -> None:
        worker = load_worker_module()
        with tempfile.TemporaryDirectory() as directory:
            token = Path(directory) / "provider.token"
            token.write_text("x" * 64 + "\n", encoding="ascii")
            token.chmod(0o400)
            with patch.object(worker, "AUTH_TOKEN_FILE", token):
                self.assertEqual(worker.load_bearer_token(), "x" * 64)
            linked = Path(directory) / "provider.link"
            os.link(token, linked)
            with patch.object(worker, "AUTH_TOKEN_FILE", token):
                with self.assertRaisesRegex(Exception, "regular file"):
                    worker.load_bearer_token()

    def test_worker_offload_cache_is_dedicated_and_rebuilt_fail_closed(self) -> None:
        worker = load_worker_module()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "offload"
            root.mkdir(mode=0o700)
            stale = root / "stale.safetensors"
            stale.write_bytes(b"stale")
            with patch.object(worker, "OFFLOAD_ROOT", root):
                worker.prepare_offload_root()
            self.assertFalse(stale.exists())
            self.assertEqual(
                sorted(item.name for item in root.iterdir()),
                ["text_encoder", "transformer"],
            )
            for item in list(root.iterdir()):
                self.assertEqual(item.stat().st_mode & 0o077, 0)
                item.rmdir()
            (root / "unsafe").symlink_to(Path(directory))
            with patch.object(worker, "OFFLOAD_ROOT", root):
                with self.assertRaisesRegex(Exception, "unsafe entry"):
                    worker.prepare_offload_root()

    def test_worker_terminal_state_is_linearized_and_never_rewritten(self) -> None:
        worker = load_worker_module()
        owner = "10000000-0000-4000-8000-000000000001"
        first = worker.JobRecord(
            job_id="10000000-0000-4000-8000-000000000002", owner_id=owner,
        )
        first.state = "running"
        worker.JOBS[first.job_id] = first
        first.cancellation.set()
        self.assertFalse(worker._commit_terminal(first, "succeeded"))
        self.assertEqual(first.state, "cancelled")
        self.assertFalse(worker._commit_terminal(first, "failed"))
        self.assertEqual(first.state, "cancelled")

        second = worker.JobRecord(
            job_id="10000000-0000-4000-8000-000000000003", owner_id=owner,
        )
        second.state = "running"
        worker.JOBS[second.job_id] = second
        self.assertTrue(worker._commit_terminal(second, "succeeded"))
        self.assertFalse(worker._commit_terminal(second, "cancelled"))
        self.assertEqual(second.state, "succeeded")

    def test_gpu_pid_exit_between_nvidia_and_proc_snapshots_is_retryable(self) -> None:
        pid = 2648433
        missing = subprocess.CompletedProcess(
            args=[], returncode=1, stdout="",
            stderr=f"cat: /proc/{pid}/cgroup: No such file or directory\n",
        )
        with patch.object(qualification, "remote_result", return_value=missing):
            with self.assertRaises(qualification.TransientGpuProcessExit):
                qualification._gpu_pid_owner(pid)

    def test_memory_sample_discards_transient_pid_exit_and_resamples(self) -> None:
        valid = {"containerCurrentBytes": 1}
        with patch.object(
            qualification, "_memory_sample",
            side_effect=[qualification.TransientGpuProcessExit("gone"), valid],
        ) as sampled, patch.object(qualification.time, "sleep") as slept:
            observed, retries = qualification._memory_sample_with_process_exit_retry(
                "worker", "a" * 64, 19104,
            )
        self.assertEqual(observed, valid)
        self.assertEqual(retries, 1)
        self.assertEqual(sampled.call_count, 2)
        slept.assert_called_once_with(0.25)

    def test_durable_ledger_reconciles_both_torn_claim_and_finalize_windows(self) -> None:
        run_id = "flux2-klein-bf16-main-protected-profile-qualification-20260904-a1"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def ledger(*arguments: str) -> subprocess.CompletedProcess[str]:
                return subprocess.run(
                    [sys.executable, "-c", qualification.LEDGER_SCRIPT,
                     str(root), *arguments], text=True,
                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False,
                )

            seed = json.dumps({"schemaVersion": 1}, separators=(",", ":"))
            self.assertEqual(ledger("claim", run_id, seed, "lease", "7200").returncode, 0)
            lease = root / "maintenance-lease.json"
            lease.unlink()  # crash after journal create but before lease durability
            state = json.loads((root / "runs" / f"{run_id}.json").read_text())
            self.assertEqual(
                ledger("reconcile-finish", run_id, str(state["revision"])).returncode, 0
            )
            self.assertEqual(
                ledger("reconcile-finish", run_id, str(state["revision"])).returncode, 0
            )
            reconciled = json.loads((root / "runs" / f"{run_id}.json").read_text())
            self.assertEqual(reconciled["state"], "reconciled")

            second = run_id.replace("a1", "a2")
            self.assertEqual(ledger("claim", second, seed, "lease", "7200").returncode, 0)
            current = json.loads((root / "runs" / f"{second}.json").read_text())
            current.update({"revision": 1, "state": "passed", "phase": "finished"})
            # Model the crash window after the terminal run journal fsync and
            # before maintenance-lease unlink/fsync.
            (root / "runs" / f"{second}.json").write_text(
                json.dumps(current, separators=(",", ":")) + "\n", encoding="utf-8"
            )
            self.assertEqual(ledger("reconcile-finish", second, "1").returncode, 0)
            self.assertEqual(ledger("reconcile-finish", second, "1").returncode, 0)
            self.assertFalse(lease.exists())
            closed = json.loads((root / "runs" / f"{second}.json").read_text())
            self.assertEqual(closed["state"], "reconciled")

            third = run_id.replace("a1", "a3")
            self.assertEqual(ledger("claim", third, seed, "lease", "7200").returncode, 0)
            self.assertEqual(ledger("finish", third, "0", "failed").returncode, 0)
            self.assertEqual(ledger("finish", third, "0", "failed").returncode, 0)
            terminal = json.loads((root / "runs" / f"{third}.json").read_text())
            self.assertEqual((terminal["state"], terminal["revision"]), ("failed", 1))

    def test_committed_failure_evidence_is_preserved_for_ledger_recovery(self) -> None:
        run_id = "flux2-klein-bf16-main-protected-profile-qualification-20260904-a12"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence_root = root / "evidence"
            evidence_root.mkdir()
            payload = {
                "runId": run_id, "status": "failed",
                "failure": {"type": "QualificationError", "message": "transport failed"},
            }
            payload["evidenceDigest"] = qualification.canonical_digest(payload)
            (evidence_root / f"{run_id}.json").write_text(
                json.dumps(payload), encoding="utf-8"
            )
            with patch.object(qualification, "ROOT", root), patch.object(
                qualification, "EVIDENCE_ROOT", evidence_root,
            ):
                observed = qualification.committed_failure_evidence(run_id)
            self.assertTrue(observed["preservedImmutable"])
            self.assertEqual(observed["evidenceDigest"], payload["evidenceDigest"])

    def test_qualification_is_durable_exact_and_has_no_live_auxiliary_dependency(self) -> None:
        runner = (ROOT / "tools/run_flux2_klein_bf16_main_protected_profile_qualification.py").read_text()
        for token in (
            "database_identity", "pg_control_system", "teamaibox_schema_migrations",
            "LEDGER_SCRIPT", "os.fsync", "reconcile_interrupted_run",
            "maintenance-lease.json", "gpu_conflict_inventory", "drain_gpu_conflicts",
            "restore_gpu_conflicts", "unknownGpuProcessIds", "ContinuousMemorySampler",
            "memory.events", "/proc/pressure/memory", "gpuPidOwnershipExact",
            "offlineImmutableParentValidation", "liveAuxiliaryDependency",
        ):
            self.assertIn(token, runner)
        self.assertNotIn("validate_replicated_flux2_klein_bf16_main_artifact.py", runner)
        self.assertNotIn('"ip", "route", "get", config["sourceNode"]', runner)
        self.assertEqual(runner.count("ORDER BY version::integer DESC LIMIT 1"), 3)
        self.assertNotIn("ORDER BY version DESC LIMIT 1", runner)
        self.assertFalse(self.config["qualificationControl"]["auxiliaryRuntimeDependency"])

    def test_failure_cleanup_is_exact_and_aggregate_deployment_is_out_of_scope(self) -> None:
        runner = (ROOT / "tools/run_flux2_klein_bf16_main_protected_profile_qualification.py").read_text()
        validator = (ROOT / "tools/validate_flux2_klein_bf16_main_protected_profile_qualification.py").read_text()
        self.assertIn('current["labels"].get("com.teamaibox.run-id") == run_id', runner)
        self.assertIn("registration_state", runner)
        self.assertIn("remove_owned_container", runner)
        self.assertIn("remove_owned_volume", runner)
        self.assertIn('"aggregateManifestUpdated": False', runner)
        self.assertIn('"task21_3Complete": False', validator)
        for source in (runner, validator):
            self.assertNotIn("protected-office-profile-set.v1.json", source)
            self.assertNotIn("aggregate-manifest", source)
            self.assertNotIn("UPDATE compute.", source)

    def test_cleanup_requires_explicit_absence_and_exact_operation_ownership(self) -> None:
        absent = subprocess.CompletedProcess(
            args=[], returncode=1, stdout="", stderr="Error: No such object: worker"
        )
        absent_network = subprocess.CompletedProcess(
            args=[], returncode=1, stdout="[]\n",
            stderr="Error response from daemon: network protected-net not found",
        )
        uncertain = subprocess.CompletedProcess(
            args=[], returncode=255, stdout="", stderr="Connection timed out"
        )
        self.assertTrue(definitely_missing(absent, "container"))
        self.assertTrue(definitely_missing(absent_network, "network"))
        self.assertFalse(definitely_missing(uncertain, "container"))
        run_id = "flux2-klein-bf16-main-protected-profile-qualification-20260904-a1"
        exact_facts = {
            "anyProfileCount": 1, "exactProfileCount": 1,
            "anyRegistrationCount": 1, "exactRegistrationCount": 1,
            "anyPlacementCount": 1, "exactPlacementCount": 1,
            "anyLifecycleCount": 1, "exactLifecycleCount": 1,
        }
        with patch.object(qualification, "query",
                          return_value=[json.dumps(exact_facts)]) as called:
            state, facts = registration_state(
                self.config, "sha256:" + "1" * 64, run_id
            )
        self.assertEqual(state, "exact")
        self.assertEqual(facts, exact_facts)
        state_sql = called.call_args.args[0]
        self.assertIn("operation_key='" + run_id + "'", state_sql)
        self.assertIn("model_profile_id='" + self.config["profileId"] + "'::uuid", state_sql)
        runner = (ROOT / "tools/run_flux2_klein_bf16_main_protected_profile_qualification.py").read_text()
        self.assertNotIn("DELETE FROM compute.model_profile_registrations", runner)
        self.assertNotIn("DELETE FROM compute.model_profile_placement_revisions", runner)

    def test_evidence_output_is_fixed_to_exact_scoped_filename(self) -> None:
        run_id = "flux2-klein-bf16-main-protected-profile-qualification-20260904-a1"
        with self.assertRaisesRegex(Exception, "unsafe or occupied"):
            qualification.run(run_id, Path("/tmp") / (run_id + "-wrong.json"))

    def test_strict_validator_accepts_complete_offline_payload_and_rejects_runtime_drift(self) -> None:
        config = self.config
        run_id = "flux2-klein-bf16-main-protected-profile-qualification-20260904-a1"
        historical = validate_historical_parent_payload(
            json.loads(HISTORICAL_PARENT.read_text(encoding="utf-8")), config
        )
        package = profile_package(config, self.parent)
        first_memory = memory_cycle(
            gpu=6 * 1024**3, current=5 * 1024**3, peak=6 * 1024**3,
            allocated=6 * 1024**3, reserved=7 * 1024**3,
            before=64 * 1024**3, after=57 * 1024**3,
        )
        second_memory = memory_cycle(
            gpu=6 * 1024**3, current=5 * 1024**3, peak=6 * 1024**3,
            allocated=6 * 1024**3, reserved=7 * 1024**3,
            before=64 * 1024**3, after=57 * 1024**3,
        )
        memory = aggregate_memory((first_memory, second_memory))
        first = runtime_snapshot(config, run_id, "2026-09-04T00:00:00Z")
        second = runtime_snapshot(config, run_id, "2026-09-04T00:05:00Z")
        runtime = {
            **second, "containerName": config["runtime"]["containerName"],
            "coldStartMs": 100, "restartReadyMs": 90,
            "engineVersion": config["engine"]["version"], "warm": True,
            "idleUnload": False, "ordinaryDrainAllowed": False,
            "generationOnly": True, "maximumConcurrentRequests": 1,
            "kvCache": config["precision"]["kvCache"],
            "restartPersistence": {
                "sameContainerId": True, "sameImageId": True,
                "startedAtAdvanced": True, "protocolPassed": True,
                "deterministicImageDigest": True,
            },
        }
        created = "2026-09-04T00:10:00.000Z"
        document = build_profile_document(
            config, self.parent, historical, package, runtime, memory, run_id, created
        )
        canonical = json.dumps(document, ensure_ascii=False, sort_keys=True,
                               separators=(",", ":"))
        fingerprint = "sha256:" + hashlib.sha256(canonical.encode()).hexdigest()
        source_rows = [{"path": item.relative_to(ROOT).as_posix(),
                        "sha256": qualification.file_digest(item)}
                       for item in qualification.SOURCES]
        payload = {
            "schemaVersion": 1,
            "runnerId": "teamaibox.flux2-klein-bf16-main-protected-profile-qualification.v1",
            "runId": run_id, "status": "passed", "failure": None,
            "target": config["target"], "profileId": config["profileId"],
            "profileKey": config["profileKey"],
            "targetIdentity": declared_target_identity(config),
            "databaseIdentity": {
                "containerId": "e" * 64, "imageId": config["database"]["imageId"],
                "configuredImage": config["database"]["configuredImage"],
                "running": True, "health": "healthy", "readOnly": True,
                "privileged": False, "systemIdentifier": config["database"]["systemIdentifier"],
                "database": config["database"]["database"], "user": config["database"]["user"],
                "serverVersionNum": config["database"]["serverVersionNum"],
                "schemaLedger": config["database"]["schemaLedger"],
            },
            "sources": source_rows,
            "configuration": {"path": qualification.CONFIG.relative_to(ROOT).as_posix(),
                              "fileSha256": qualification.file_digest(qualification.CONFIG),
                              "document": config},
            "parent": self.parent, "historicalMeasurementParent": historical,
            "profilePackage": package,
            "registrationPreflight": {
                "profileIdAvailable": True, "profileKeyAvailable": True,
                "packageIdentityAvailable": True, "lifecycleEventIdAvailable": True,
                "placementRevisionIdAvailable": True, "operationKeyAvailable": True,
            },
            "startAdmission": {
                "hostMemoryAvailableBytes": 100 * 1024**3,
                "minimumProtectedStartAvailableBytes": 60_617_416_704,
                "minimumStandaloneQualificationAvailableBytes": 96 * 1024**3,
                "minimumCoreServiceReserveBytes": 32 * 1024**3,
                "minimumTransientMarginBytes": 16 * 1024**3,
                "protectedSlotAdmissionBytes": 9_077_809_152,
                "protectedOfficeSetModelCeilingBytes": 68_719_476_736,
                "preFluxProtectedOfficeSetBytes": 59_641_667_584,
                "normalProtectedStartUsesPerProfile96GiBGate": False,
                "explicitStandaloneQualificationGateApplied": True,
                "measuredAfterExactGpuConflictDrain": True,
            },
            "networkPreflight": {
                "subnet": config["runtime"]["networkSubnet"],
                "gateway": config["runtime"]["networkGateway"],
                "isolation": config["runtime"]["networkIsolation"],
                "overlapFree": True, "occupiedSubnetCount": 7,
                "occupiedSubnetSetDigest": "sha256:" + "c" * 64,
                "routeBeforeNetworkCreate": {
                    "auxiliaryRuntimeDependency": False, "liveAuxiliaryChecks": [],
                    "kernelRouteCount": 2, "kernelRouteTableDigest": "sha256:" + "a" * 64,
                    "managementRoute": {
                        "dst": config["sourceNode"]["managementAddress"],
                        "dev": "enP7s7", "prefsrc": config["target"]["nodeAddress"],
                        "gateway": None, "table": None,
                    },
                    "fabricRoute": {
                        "dst": config["sourceNode"]["fabricAddress"],
                        "dev": config["sourceNode"]["fabricInterface"],
                        "prefsrc": config["sourceNode"]["fabricSourceAddress"],
                        "gateway": None, "table": None,
                    },
                },
                "routeAfterNetworkCreate": {
                    "auxiliaryRuntimeDependency": False, "liveAuxiliaryChecks": [],
                    "kernelRouteCount": 2, "kernelRouteTableDigest": "sha256:" + "a" * 64,
                    "managementRoute": {
                        "dst": config["sourceNode"]["managementAddress"],
                        "dev": "enP7s7", "prefsrc": config["target"]["nodeAddress"],
                        "gateway": None, "table": None,
                    },
                    "fabricRoute": {
                        "dst": config["sourceNode"]["fabricAddress"],
                        "dev": config["sourceNode"]["fabricInterface"],
                        "prefsrc": config["sourceNode"]["fabricSourceAddress"],
                        "gateway": None, "table": None,
                    },
                },
            },
            "durableRunLedger": {
                "volume": config["qualificationControl"]["ledgerVolume"],
                "mountpoint": "redacted-host-managed-volume", "driver": "local",
                "fsyncRequired": True, "runId": run_id,
                "sourceSetDigest": canonical_digest(source_rows),
                "databaseContainerId": "e" * 64,
                "databaseImageId": config["database"]["imageId"],
                "databaseConfiguredImage": config["database"]["configuredImage"],
                "databaseSystemIdentifier": config["database"]["systemIdentifier"],
                "schemaLedger": config["database"]["schemaLedger"],
                "reconciliationRequired": True, "finalRevision": 7, "finalState": "passed",
            },
            "maintenanceLease": {
                "name": config["qualificationControl"]["maintenanceLeaseName"],
                "runId": run_id,
                "ttlSeconds": config["qualificationControl"]["maintenanceLeaseTtlSeconds"],
                "heartbeatSeconds":
                    config["qualificationControl"]["maintenanceLeaseHeartbeatSeconds"],
                "fencedByLedgerRevision": True, "continuouslyRenewed": True,
                "released": True,
            },
            "gpuMaintenance": {
                "policy": "inventory-and-drain-all-running-gpu-containers",
                "containers": [], "observedGpuProcessIds": [],
                "unknownGpuProcessIds": [], "exactOwnership": True,
                "drainedContainerIds": [], "restoredContainerIds": [],
                "leaseHeldForDrain": True, "exactRestore": True,
            },
            "network": {
                "id": "b" * 64, "name": config["runtime"]["networkName"],
                "driver": "bridge", "internal": False, "attachable": False,
                "ingress": False,
                "options": {
                    "com.docker.network.bridge.enable_icc": "false",
                    "com.docker.network.bridge.enable_ip_masquerade": "false",
                },
                "labels": {
                    "com.teamaibox.managed": "true",
                    "com.teamaibox.purpose": "protected-resident-loopback-only-network",
                    "com.teamaibox.component": "drawing-flux2-klein-bf16",
                    "com.teamaibox.run-id": run_id,
                },
                "containerIds": ["a" * 64],
                "ipam": [{"subnet": config["runtime"]["networkSubnet"],
                          "gateway": config["runtime"]["networkGateway"]}],
            },
            "networkIsolationProbe": {
                "passed": True,
                "policy": config["runtime"]["networkIsolation"],
                "targets": [
                    {"name": "auxiliary-management",
                     "address": config["sourceNode"]["managementAddress"],
                     "port": 22, "connectCode": 11, "reachable": False},
                    {"name": "auxiliary-fabric",
                     "address": config["sourceNode"]["fabricAddress"],
                     "port": 22, "connectCode": 11, "reachable": False},
                    {"name": "external-internet", "address": "1.1.1.1",
                     "port": 443, "connectCode": 11, "reachable": False},
                ],
                "loopbackPublicationValidatedByRealProtocolProbe": True,
            },
            "probeStaging": {
                "path": "/tmp/teamaibox-" + run_id + "-probe.py",
                "sha256": qualification.file_digest(qualification.PROBE),
                "serverPath": "/tmp/teamaibox-" + run_id + "-server.py",
                "serverSha256": qualification.file_digest(qualification.SERVER),
                "removedAfterRun": True,
            },
            "runtimeBundle": {
                "volume": config["artifact"]["runtimeBundleVolume"], "runId": run_id,
                "driver": "local", "labels": {
                    "com.teamaibox.managed": "true",
                    "com.teamaibox.purpose": "protected-resident-runtime-bundle",
                    "com.teamaibox.component": "drawing-flux2-klein-bf16",
                    "com.teamaibox.run-id": run_id,
                },
                "serverPath": "/runtime/flux2_bf16_protected_server.py",
                "serverSha256": qualification.file_digest(qualification.SERVER),
                "readOnlyAtRuntime": True,
                "fileManifest": [{
                    "path": "flux2_bf16_protected_server.py", "type": "regular-file",
                    "sha256": qualification.file_digest(qualification.SERVER),
                }],
            },
            "authentication": {
                "scheme": "Bearer", "ownerHeader": "X-TeamAIBox-Owner",
                "volume": config["runtime"]["authenticationVolume"], "runId": run_id,
                "file": "/run/secrets/auth/provider.token", "fileMode": "0400",
                "fileType": "regular-file", "hardLinkCount": 1,
                "processUid": 65532, "processGid": 65532,
                "readOnlyAtRuntime": True,
                "credentialRetained": False, "credentialDigestRetained": False,
            },
            "offloadCache": {
                "volume": config["runtime"]["offloadVolume"], "runId": run_id,
                "driver": "local", "labels": {
                    "com.teamaibox.managed": "true",
                    "com.teamaibox.purpose": "protected-resident-disk-offload-cache",
                    "com.teamaibox.component": "drawing-flux2-klein-bf16",
                    "com.teamaibox.run-id": run_id,
                },
                "mountPath": config["runtime"]["offloadMountPath"], "fileMode": "0700",
                "processUid": 65532, "processGid": 65532, "disposable": True,
                "containsUserContent": False,
                "memoryStrategy": config["runtime"]["memoryStrategy"],
            },
            "cycles": [
                {"cycle": 1, "runtime": first,
                 "protocol": protocol_fixture(config["runtime"]["servedModel"], 1),
                 "memory": first_memory},
                {"cycle": 2, "runtime": second,
                 "protocol": protocol_fixture(config["runtime"]["servedModel"], 2),
                 "memory": second_memory},
            ],
            "memoryEnvelope": memory,
            "protectedOfficeSetBudget": {
                "accountingPolicy": "sum-of-exact-profile-admission-bytes",
                "modelResidentCeilingBytes": 68_719_476_736,
                "preFluxAccountedBytes": 59_641_667_584,
                "fluxMaximumAdmissionBytes": 9_077_809_152,
                "measuredFluxAdmissionBytes": memory["admissionBytes"],
                "resultingAggregateAccountingBytes":
                    59_641_667_584 + memory["admissionBytes"],
                "componentAdmissionWithinRemainder": True,
                "aggregateCoexistenceMeasured": False,
                "aggregateCoexistenceRequiredBeforeRouting": True,
            },
            "runtime": runtime,
            "profileRegistration": {
                "registered": True, "transactional": True,
                "profileFingerprint": fingerprint,
                "profilePackageArtifactDigest": package["digest"],
                "weightsArtifactDigest": config["artifact"]["weightsArtifactDigest"],
                "placementRevisionId": config["placementRevisionId"],
                "nodeGroupId": config["target"]["nodeGroupId"],
                "maintenanceGeneration": 1, "commitResponseObserved": True,
                "placementState": "loading", "routingEligible": False,
                "productAccepted": False,
                "reconciledState": "exact",
                "reconciledFacts": {
                    "anyProfileCount": 1, "exactProfileCount": 1,
                    "anyRegistrationCount": 1, "exactRegistrationCount": 1,
                    "anyPlacementCount": 1, "exactPlacementCount": 1,
                    "anyLifecycleCount": 1, "exactLifecycleCount": 1,
                },
                "document": document,
            },
            "privacy": {"credentialsRetained": False, "userContentRetained": False,
                        "imageContentRetained": False, "syntheticContentOnly": True,
                        "rawCommandOutputRetained": False,
                        "redactedFailureDiagnosticRetained": False},
            "claimBoundary": {
                "componentReady": False, "standaloneQualificationPassed": True,
                "profilePrepared": True, "protectedProfileRegistered": True,
                "aggregateCoexistenceQualified": False,
                "aggregateManifestUpdated": False, "protectedOfficeSetDeployed": False,
                "productRouted": False, "task21_3Complete": False,
                "task21_4Complete": False,
            },
            "cleanup": {
                "databaseCommitted": True, "registrationAttempted": True,
                "registrationStateAfterFailure": None,
                "registrationFactsAfterFailure": None,
                "successfulRuntimeRetained": True,
                "successfulRuntimeBundleRetained": True,
                "successfulAuthenticationVolumeRetained": True,
                "successfulOffloadVolumeRetained": True,
                "successfulPrivateNetworkRetained": True,
                "exactGpuConflictsRestored": True,
                "failedImmutableRegistrationAbsent": None, "failedExactRuntimeRemoved": None,
                "failedExactRuntimeBundleRemoved": None,
                "failedExactAuthenticationVolumeRemoved": None,
                "failedExactOffloadVolumeRemoved": None,
                "failedExactPrivateNetworkRemoved": None,
                "replicatedModelVolumeUntouched": True,
                "replicatedRuntimeImageUntouched": True,
            },
        }
        payload["evidenceDigest"] = canonical_digest(payload)
        result = validator.validate_payload(payload, revalidate=False)
        self.assertTrue(result["valid"])
        self.assertEqual(result["admissionBytes"], 7 * 1024**3 + 256 * 1024**2)
        drifted = deepcopy(payload)
        drifted["runtime"]["memoryBytes"] = 9_077_809_151
        unsigned = dict(drifted)
        unsigned.pop("evidenceDigest")
        drifted["evidenceDigest"] = canonical_digest(unsigned)
        with self.assertRaisesRegex(Exception, "runtime hardening"):
            validator.validate_payload(drifted, revalidate=False)

        restarted = deepcopy(payload)
        restarted["cycles"][0]["runtime"]["restartCount"] = 1
        unsigned = dict(restarted)
        unsigned.pop("evidenceDigest")
        restarted["evidenceDigest"] = canonical_digest(unsigned)
        with self.assertRaisesRegex(Exception, "runtime hardening"):
            validator.validate_payload(restarted, revalidate=False)

    def test_network_is_fixed_overlap_checked_and_route_preserving(self) -> None:
        runner = (ROOT / "tools/run_flux2_klein_bf16_main_protected_profile_qualification.py").read_text()
        validator_source = (
            ROOT / "tools/validate_flux2_klein_bf16_main_protected_profile_qualification.py"
        ).read_text()
        self.assertIn('"--subnet", runtime["networkSubnet"]', runner)
        self.assertIn('"--gateway", runtime["networkGateway"]', runner)
        self.assertIn('"com.docker.network.bridge.enable_ip_masquerade=false"', runner)
        self.assertIn('"com.docker.network.bridge.enable_icc=false"', runner)
        self.assertNotIn('"network", "create", "--internal"', runner)
        self.assertIn("network_isolation_probe(config, worker)", runner)
        self.assertIn("network_subnet_preflight(config)", runner)
        self.assertIn('protected_network["ipam"] == [{', runner)
        self.assertIn('network.get("ipam") == expected_ipam', validator_source)
        self.assertIn("route_facts(config)", validator_source)

    def test_route_facts_bind_only_management_and_fabric_routes(self) -> None:
        management = [{
            "dst": self.config["sourceNode"]["managementAddress"], "dev": "enP7s7",
            "prefsrc": self.config["target"]["nodeAddress"], "uid": 1000,
            "flags": [], "cache": [],
        }]
        fabric = [{
            "dst": self.config["sourceNode"]["fabricAddress"],
            "dev": self.config["sourceNode"]["fabricInterface"],
            "prefsrc": self.config["sourceNode"]["fabricSourceAddress"],
            "uid": 1000, "flags": [], "cache": [],
        }]
        with patch.object(
            qualification, "remote",
            side_effect=[json.dumps(management), json.dumps(fabric)],
        ):
            facts = qualification.route_facts(self.config)
        expected_management = {
            "dst": management[0]["dst"], "dev": "enP7s7",
            "prefsrc": management[0]["prefsrc"], "gateway": None, "table": None,
        }
        expected_fabric = {
            "dst": fabric[0]["dst"], "dev": fabric[0]["dev"],
            "prefsrc": fabric[0]["prefsrc"], "gateway": None, "table": None,
        }
        self.assertEqual(facts["kernelRouteCount"], 2)
        self.assertEqual(facts["managementRoute"], expected_management)
        self.assertEqual(facts["fabricRoute"], expected_fabric)
        self.assertEqual(
            facts["kernelRouteTableDigest"],
            canonical_digest([expected_management, expected_fabric]),
        )
        self.assertFalse(facts["auxiliaryRuntimeDependency"])
        self.assertEqual(facts["liveAuxiliaryChecks"], [])

    def test_route_facts_fails_closed_on_fabric_source_drift(self) -> None:
        management = [{
            "dst": self.config["sourceNode"]["managementAddress"], "dev": "enP7s7",
            "prefsrc": self.config["target"]["nodeAddress"],
        }]
        fabric = [{
            "dst": self.config["sourceNode"]["fabricAddress"],
            "dev": self.config["sourceNode"]["fabricInterface"],
            "prefsrc": "172.31.254.99",
        }]
        with patch.object(
            qualification, "remote",
            side_effect=[json.dumps(management), json.dumps(fabric)],
        ):
            with self.assertRaisesRegex(Exception, "Fabric route"):
                qualification.route_facts(self.config)

    def test_exact_run_claim_is_atomic(self) -> None:
        run_id = "flux2-klein-bf16-main-protected-profile-qualification-20260904-a1"
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / (run_id + ".json")
            claim = claim_exact_run(output, run_id)
            with self.assertRaisesRegex(Exception, "already claimed"):
                claim_exact_run(output, run_id)
            output.write_text("{}\n", encoding="utf-8")
            release_exact_run_claim(claim, output, run_id)
            self.assertFalse(claim.exists())

    def test_diagnostics_are_redacted_and_profile_has_worker_wall_clock_limit(self) -> None:
        masked = redact(
            'Authorization: Bearer bearer-secret {"secret":"json-secret"} '
            '--password cli-secret https://u:uri-secret@example.test'
        )
        for secret in ("bearer-secret", "json-secret", "cli-secret", "uri-secret"):
            self.assertNotIn(secret, masked)
        package = profile_package(self.config, self.parent)
        historical = validate_historical_parent_payload(
            json.loads(HISTORICAL_PARENT.read_text(encoding="utf-8")), self.config
        )
        memory = aggregate_memory((
            memory_cycle(gpu=10, current=8, peak=9, allocated=10, reserved=11,
                         before=100 * 1024**3, after=99 * 1024**3),
            memory_cycle(gpu=10, current=8, peak=9, allocated=10, reserved=11,
                         before=100 * 1024**3, after=99 * 1024**3),
        ))
        document = build_profile_document(
            self.config, self.parent, historical, package,
            {"coldStartMs": 1, "restartReadyMs": 1}, memory,
            "flux2-klein-bf16-main-protected-profile-qualification-20260904-a1",
            "2026-09-04T00:00:00.000Z",
        )
        self.assertEqual(self.config["runtime"]["requestTimeoutSeconds"], 600)
        self.assertIn("600-second wall-clock", " ".join(document["knownLimitations"]))

    def test_registration_validator_json_keys_are_unique(self) -> None:
        source = (
            ROOT / "tools/validate_flux2_klein_bf16_main_protected_profile_qualification.py"
        ).read_text()
        start = source.index("SELECT (jsonb_build_object(")
        end = source.index(")::text", start)
        keys = __import__("re").findall(r"'([A-Za-z][A-Za-z0-9]*)'\s*,", source[start:end])
        self.assertEqual(len(keys), len(set(keys)))
        self.assertIn("profilePlacementClass", keys)
        self.assertIn("placementPlacementClass", keys)
        self.assertEqual(source[start:end].count("jsonb_build_object("), 2)
        self.assertIn(") || jsonb_build_object(", source[start:end])
        self.assertNotIn("SELECT json_build_object(", source[start:end])
        segments = source[start:end].split(") || jsonb_build_object(")
        self.assertEqual(len(segments), 2)
        for segment in segments:
            segment_keys = __import__("re").findall(
                r"'([A-Za-z][A-Za-z0-9]*)'\s*,", segment
            )
            self.assertLessEqual(len(segment_keys), 50)
        self.assertIn('"$created$"', source[source.index("def registration_facts"):end])

    def test_registration_created_at_is_canonical_and_dollar_quote_safe(self) -> None:
        self.assertEqual(
            validator.validated_created_at({"createdAt": "2026-09-04T00:00:00.000Z"}),
            "2026-09-04T00:00:00.000Z",
        )
        with self.assertRaisesRegex(ValueError, "canonical UTC milliseconds"):
            validator.validated_created_at({
                "createdAt": "2026-09-04T00:00:00.000Z$created$;SELECT 1;"
            })
        with self.assertRaisesRegex(ValueError, "valid UTC instant"):
            validator.validated_created_at({"createdAt": "2026-02-30T00:00:00.000Z"})

    def test_validator_uses_fresh_probe_owner_to_avoid_job_tombstone_collision(self) -> None:
        validator_source = (
            ROOT / "tools/validate_flux2_klein_bf16_main_protected_profile_qualification.py"
        ).read_text()
        probe_source = (
            ROOT / "tools/flux2_klein_bf16_main_protected_probe.py"
        ).read_text()
        self.assertIn("probe_owner_id=str(uuid.uuid4())", validator_source)
        self.assertIn(
            'job_scope = f"teamaibox:flux2-bf16:{owner_id}:{cycle}"',
            probe_source,
        )
        self.assertNotIn(
            'uuid.NAMESPACE_URL, f"teamaibox:flux2-bf16:{cycle}:generation"',
            probe_source,
        )

    def test_probe_owner_is_forwarded_behaviorally(self) -> None:
        owner = "10000000-0000-4000-8000-000000000099"

        class Sampler:
            def start(self):
                return self

            def finish(self):
                return memory_cycle(
                    gpu=10, current=8, peak=9, allocated=10, reserved=11,
                    before=100 * 1024**3, after=99 * 1024**3,
                )

        with patch.object(
            qualification, "ContinuousMemorySampler", return_value=Sampler()
        ), patch.object(
            qualification, "run_probe", return_value=protocol_fixture(
                self.config["runtime"]["servedModel"], 1
            )
        ) as run_probe:
            qualification.run_probe_with_memory(
                self.config, "/tmp/exact-probe.py", 1, "/tmp/exact-token",
                "exact-worker", "a" * 64, 100 * 1024**3,
                probe_owner_id=owner,
            )
        run_probe.assert_called_once_with(
            self.config, "/tmp/exact-probe.py", 1, "/tmp/exact-token",
            owner_id=owner,
        )


if __name__ == "__main__":
    unittest.main()

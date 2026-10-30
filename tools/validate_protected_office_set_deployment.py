#!/usr/bin/env python3
"""Strictly validate one exact protected office-set deployment run."""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path
from typing import Any, Mapping, Sequence

try:
    from .run_protected_office_set_deployment import (
        ACTIONS, AUTHORIZED_ACTIONS, BUDGET, EVIDENCE_ROOT, LAUNCH_RUNNER_ID,
        MANIFEST, PLAN, ROOT, RUN_ID, RUNNER_ID, SHA256, TARGET_ADDRESS, DeploymentContract,
        ReadOnlyInspector,
        action_identity, aggregate_qualification, file_sha, source_binding, source_tests, validate_action_result,
        validate_plan,
    )
    from .run_spark_model_baseline import canonical_digest
except ImportError:
    from run_protected_office_set_deployment import (
        ACTIONS, AUTHORIZED_ACTIONS, BUDGET, EVIDENCE_ROOT, LAUNCH_RUNNER_ID,
        MANIFEST, PLAN, ROOT, RUN_ID, RUNNER_ID, SHA256, TARGET_ADDRESS, DeploymentContract,
        ReadOnlyInspector,
        action_identity, aggregate_qualification, file_sha, source_binding, source_tests, validate_action_result,
        validate_plan,
    )
    from run_spark_model_baseline import canonical_digest


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def _parent_projection(value: Mapping[str, Any]) -> dict[str, Any]:
    return {name: {
        key: binding.get(key) for key in ("path", "runId", "runnerId", "evidenceDigest", "validator")
    } for name, binding in value.items()}


def _validate_launch(binding: object, *, run_id: str, plan: Mapping[str, Any],
                     parents: Mapping[str, Any],
                     contract: DeploymentContract | None = None) -> None:
    evidence_root = contract.evidence_root if contract is not None else EVIDENCE_ROOT
    plan_path = contract.plan if contract is not None else PLAN
    launch_runner_id = contract.launch_runner_id if contract is not None else LAUNCH_RUNNER_ID
    additional_sources = contract.additional_sources if contract is not None else ()
    require(isinstance(binding, Mapping), "protected office deployment launch binding is missing")
    path_value = binding.get("path")
    require(isinstance(path_value, str), "protected office deployment launch path is invalid")
    path = (ROOT / path_value).resolve()
    require(path.is_file() and path.parent == evidence_root.resolve()
            and path.name == run_id + "-launch.json", "protected office deployment launch is unscoped")
    launch = json.loads(path.read_text(encoding="utf-8"))
    recorded = launch.pop("evidenceDigest", None)
    require(recorded == canonical_digest(launch), "protected office deployment launch digest drifted")
    launch["evidenceDigest"] = recorded
    require(binding == {"path": path.relative_to(ROOT).as_posix(),
                        "evidenceDigest": recorded, "fileSha256": file_sha(path)},
            "protected office deployment launch binding drifted")
    require(launch.get("schemaVersion") == 1 and launch.get("runnerId") == launch_runner_id
            and launch.get("runId") == run_id and launch.get("status") == "authorized"
            and isinstance(launch.get("authorizedAt"), str) and launch["authorizedAt"].endswith("Z")
            and launch.get("target") == {
                "nodeAddress": TARGET_ADDRESS, "nodeRole": "main-box",
                "nodeId": plan["target"]["nodeId"],
                "nodeGeneration": plan["target"]["nodeGeneration"],
                "platformIdentity": plan["target"]["platformIdentity"],
                "nodeAgentIdentity": plan["target"]["nodeAgentIdentity"],
            }
            and launch.get("plan") == {
                "path": plan_path.relative_to(ROOT).as_posix(), "fileSha256": file_sha(plan_path),
            }
            and launch.get("manifest") == {
                "path": MANIFEST.relative_to(ROOT).as_posix(), "fileSha256": file_sha(MANIFEST),
            }
            and _parent_projection(launch.get("parents") or {}) == _parent_projection(parents)
            and launch.get("sources") == source_binding(
                plan, additional_sources=additional_sources)
            and launch.get("privacy") == {
                "credentialsRetained": False, "userContentRetained": False,
                "protocolBodiesRetained": False, "adapterOutputRetained": False,
            }
            and launch.get("actions") == [{
                "action": action, "actionId": action_identity(run_id, action)[0],
                "idempotencyKey": action_identity(run_id, action)[1],
            } for action in AUTHORIZED_ACTIONS], "protected office deployment launch drifted")


def validate_payload(value: dict[str, Any], *, revalidate_plan: bool,
                     live_inspector: Any | None = None,
                     contract: DeploymentContract | None = None) -> dict[str, Any]:
    plan_path = contract.plan if contract is not None else PLAN
    run_id_pattern = contract.run_id if contract is not None else RUN_ID
    runner_id = contract.runner_id if contract is not None else RUNNER_ID
    additional_sources = contract.additional_sources if contract is not None else ()
    python_test_module = (contract.python_test_module if contract is not None
                          else "tests.test_protected_office_set_deployment")
    deployment_id = (contract.deployment_id if contract is not None
                     else "teamaibox.protected-office-set-deployment.v2")
    recorded = value.pop("evidenceDigest", None)
    require(recorded == canonical_digest(value), "protected office deployment evidence digest drifted")
    value["evidenceDigest"] = recorded
    require(value.get("schemaVersion") == 1 and value.get("runnerId") == runner_id
            and run_id_pattern.fullmatch(str(value.get("runId", ""))) is not None
            and value.get("status") == "passed" and value.get("failure") is None
            and value.get("recovery") is None
            and all(isinstance(value.get(key), str) and value[key].endswith("Z")
                    for key in ("startedAt", "completedAt")),
            "protected office deployment is not an exact pass")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    require(value.get("plan") == {
        "path": plan_path.relative_to(ROOT).as_posix(), "fileSha256": file_sha(plan_path),
    }, "protected office deployment plan binding drifted")
    require(value.get("manifest") == {
        "path": MANIFEST.relative_to(ROOT).as_posix(), "fileSha256": file_sha(MANIFEST),
    }, "protected office manifest binding drifted")
    expected = validate_plan(
        plan, run_parent_validators=revalidate_plan,
        expected_deployment_id=deployment_id,
    )
    require(value.get("target") == {
        "nodeAddress": TARGET_ADDRESS, "nodeRole": "main-box",
        "nodeId": plan["target"]["nodeId"], "nodeGeneration": plan["target"]["nodeGeneration"],
    }, "protected office deployment target drifted")
    require(value.get("budget") == BUDGET
            and value.get("aggregateAccountingBytes") == expected["aggregateAccountingBytes"]
            and value.get("profileCount") == 6, "protected office aggregate evidence drifted")
    parents = value.get("parents")
    require(isinstance(parents, Mapping)
            and _parent_projection(parents) == _parent_projection(expected["parents"]),
            "protected office deployment parent chain drifted")
    _validate_launch(
        value.get("launch"), run_id=value["runId"], plan=plan,
        parents=parents, contract=contract,
    )
    actions = value.get("actions")
    require(isinstance(actions, Mapping) and set(actions.keys()) == set(ACTIONS)
            and value.get("actionOrder") == list(ACTIONS),
            "protected office deployment action set drifted")
    for action in ACTIONS:
        validate_action_result(action, actions[action], plan, run_id=value["runId"])
    require(value.get("canonicalMigration") == expected["canonicalMigration"],
            "protected office canonical migration projection drifted")
    require(value.get("aggregateQualification") == aggregate_qualification(
        plan, actions, expected["canonicalMigration"]),
            "protected office aggregate coexistence qualification drifted")
    require(value.get("sources") == source_binding(
        plan, additional_sources=additional_sources),
            "protected office deployment source binding drifted")
    tests = value.get("sourceTests")
    require(isinstance(tests, Mapping) and set(tests.keys()) == {"node", "python", "production"}
            and all(isinstance(tests.get(name), Mapping)
                    and tests[name].get("passed") is True
                    and SHA256.fullmatch(tests[name].get("outputDigest", ""))
                    and tests[name].get("outputRetained") is False
                    for name in ("node", "python", "production"))
            and tests["production"].get("testPaths")
                == plan["controller"]["productionTestPaths"],
            "protected office deployment source-test evidence drifted")
    require(value.get("privacy") == {
        "credentialsRetained": False, "userContentRetained": False,
        "protocolBodiesRetained": False, "adapterOutputRetained": False,
    }, "protected office deployment privacy boundary drifted")
    require(value.get("claimBoundary") == {
        "profileSetQualified": True, "protectedOfficeSetDeployed": True,
        "aggregateCoexistenceQualified": True, "noCastBaselineQualified": True,
        "task21_3Complete": True, "task21_4Complete": True,
        "drawingIntentRoutingQualified": False, "task21_5Complete": False,
        "castingCoexistenceQualified": False, "task22_9Complete": False,
    }, "protected office deployment claim boundary drifted")
    if revalidate_plan:
        source_tests(plan, python_test_module=python_test_module)
    if live_inspector is not None:
        live_inspector.inspect(value["runId"])
    return {
        "valid": True, "runId": value["runId"], "evidenceDigest": recorded,
        "profileCount": 6, "aggregateAccountingBytes": expected["aggregateAccountingBytes"],
        "noCastBaselineQualified": True, "task21_4Complete": True,
        "task21_5Complete": False, "task22_9Complete": False,
    }


def validate(path: Path, *, contract: DeploymentContract | None = None) -> dict[str, Any]:
    evidence_root = contract.evidence_root if contract is not None else EVIDENCE_ROOT
    plan_path = contract.plan if contract is not None else PLAN
    resolved = path.resolve()
    require(resolved.is_file() and resolved.parent == evidence_root.resolve(),
            "protected office deployment evidence is unscoped")
    value = json.loads(resolved.read_text(encoding="utf-8"))
    require(resolved.name == str(value.get("runId")) + ".json",
            "protected office deployment evidence filename drifted")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    return validate_payload(
        value, revalidate_plan=True, live_inspector=ReadOnlyInspector(plan),
        contract=contract,
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args(argv)
    print(json.dumps(validate(args.evidence), sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

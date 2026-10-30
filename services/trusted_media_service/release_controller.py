"""Crash-recoverable lifecycle control for the trusted media release set.

The controller does not open the Docker socket.  Its adapter is expected to be a
signed mTLS Node Agent client which implements only the exact release operations
below.  State contains public immutable release identities only; session PINs,
keys, source labels, viewer credentials and media never cross this boundary.
"""

from __future__ import annotations

from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
from typing import Callable, Mapping, Protocol, Sequence


DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
RELEASE_ID = re.compile(r"^[a-z0-9][a-z0-9.-]{0,126}[a-z0-9]$")
PUBLIC_RELEASE_KEYS = {
    "releaseId",
    "architecture",
    "trustedMediaImageDigest",
    "sfuImageDigest",
    "runtimePolicyDigest",
    "sourceLockDigest",
    "hardwareEvidenceDigest",
    "rootfsManifestDigest",
    "releaseEligible",
    "hardwareSupported",
    "healthTimeoutSeconds",
}


class MediaReleaseError(RuntimeError):
    """A stable, non-secret lifecycle error."""

    def __init__(self, code: str, message: str, *, blockers: Sequence[str] = ()) -> None:
        super().__init__(message)
        self.code = code
        self.blockers = tuple(sorted(set(blockers)))


class RuntimeAdapter(Protocol):
    """Narrow Node Agent boundary; no arbitrary command execution is exposed."""

    def start(self, release: Mapping[str, object]) -> None: ...

    def wait_healthy(self, release: Mapping[str, object], timeout_seconds: int) -> bool: ...

    def withdraw_discovery(self, release: Mapping[str, object]) -> None: ...

    def stop(self, release: Mapping[str, object]) -> None: ...

    def clear_ephemeral_state(self, release: Mapping[str, object]) -> None: ...

    def remove(self, release: Mapping[str, object]) -> None: ...


AdmissionCheck = Callable[[Mapping[str, object]], Sequence[str]]


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def _digest(value: object) -> str:
    return "sha256:" + hashlib.sha256(_canonical(value)).hexdigest()


def _public_release(value: Mapping[str, object]) -> dict[str, object]:
    if set(value) != PUBLIC_RELEASE_KEYS:
        raise MediaReleaseError("media_release_descriptor_invalid", "release descriptor fields are not exact")
    release = dict(value)
    release_id = release.get("releaseId")
    if not isinstance(release_id, str) or not RELEASE_ID.fullmatch(release_id):
        raise MediaReleaseError("media_release_descriptor_invalid", "release identity is invalid")
    if release.get("architecture") != "linux/arm64/v8":
        raise MediaReleaseError("media_release_architecture_invalid", "release is not the pinned ARM64 target")
    for key in (
        "trustedMediaImageDigest",
        "sfuImageDigest",
        "runtimePolicyDigest",
        "sourceLockDigest",
        "hardwareEvidenceDigest",
        "rootfsManifestDigest",
    ):
        if not isinstance(release.get(key), str) or not DIGEST.fullmatch(str(release[key])):
            raise MediaReleaseError("media_release_descriptor_invalid", f"{key} is not pinned")
    if release.get("releaseEligible") is not True or release.get("hardwareSupported") is not True:
        raise MediaReleaseError("media_release_not_eligible", "release or hardware gate is not approved")
    timeout = release.get("healthTimeoutSeconds")
    if not isinstance(timeout, int) or isinstance(timeout, bool) or not 5 <= timeout <= 300:
        raise MediaReleaseError("media_release_descriptor_invalid", "health timeout is outside the bounded range")
    return release


class MediaReleaseController:
    """Serialize exact release changes and restore the prior healthy identity."""

    def __init__(
        self,
        *,
        state_directory: Path,
        runtime: RuntimeAdapter,
        admission_check: AdmissionCheck,
    ) -> None:
        self._root = Path(state_directory)
        if not self._root.is_absolute():
            raise ValueError("state_directory must be absolute")
        self._runtime = runtime
        self._admission_check = admission_check
        self._state_path = self._root / "release-state.json"
        self._lock_path = self._root / "release-state.lock"

    def initialize(self) -> dict[str, object]:
        self._root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with self._locked():
            if not self._state_path.exists():
                self._write_state(self._empty_state())
            state = self._read_state()
            if state["transaction"] is not None:
                state = self._recover_locked(state)
            return self._copy(state)

    def stage(self, release: Mapping[str, object]) -> dict[str, object]:
        candidate = _public_release(release)
        blockers = tuple(self._admission_check(candidate))
        if blockers:
            raise MediaReleaseError(
                "media_release_prerequisite_unmet",
                "trusted media release is blocked by exact prerequisites",
                blockers=blockers,
            )
        with self._locked():
            state = self._read_state()
            self._require_no_transaction(state)
            staged = state["staged"]
            if staged is not None and staged["trustedMediaImageDigest"] != candidate["trustedMediaImageDigest"]:
                raise MediaReleaseError("media_release_conflict", "another exact media release is staged")
            state["staged"] = candidate
            state["lastFailureCode"] = None
            self._write_state(state)
            return self._copy(state)

    def activate(self, *, transaction_id: str, trusted_media_image_digest: str) -> dict[str, object]:
        self._validate_transaction_id(transaction_id)
        if not DIGEST.fullmatch(trusted_media_image_digest):
            raise MediaReleaseError("media_release_descriptor_invalid", "candidate image digest is invalid")
        with self._locked():
            state = self._read_state()
            self._require_no_transaction(state)
            candidate = state["staged"]
            if candidate is None or candidate["trustedMediaImageDigest"] != trusted_media_image_digest:
                raise MediaReleaseError("media_release_not_staged", "exact media release was not staged")
            blockers = tuple(self._admission_check(candidate))
            if blockers:
                raise MediaReleaseError(
                    "media_release_prerequisite_unmet",
                    "trusted media release prerequisites changed after staging",
                    blockers=blockers,
                )
            return self._switch_locked(
                state,
                transaction_id=transaction_id,
                operation="activate",
                desired=candidate,
                restore_target=state["active"],
                previous_after_success=state["active"],
            )

    def upgrade(self, *, transaction_id: str, trusted_media_image_digest: str) -> dict[str, object]:
        """Atomically replace an installed release with one exact staged release."""

        self._validate_transaction_id(transaction_id)
        if not DIGEST.fullmatch(trusted_media_image_digest):
            raise MediaReleaseError("media_release_descriptor_invalid", "candidate image digest is invalid")
        with self._locked():
            state = self._read_state()
            self._require_no_transaction(state)
            current = state["active"]
            candidate = state["staged"]
            if current is None:
                raise MediaReleaseError("media_release_not_installed", "no trusted media release is installed")
            if candidate is None or candidate["trustedMediaImageDigest"] != trusted_media_image_digest:
                raise MediaReleaseError("media_release_not_staged", "exact media release was not staged")
            if candidate["trustedMediaImageDigest"] == current["trustedMediaImageDigest"]:
                raise MediaReleaseError("media_release_conflict", "staged media release is already active")
            blockers = tuple(self._admission_check(candidate))
            if blockers:
                raise MediaReleaseError(
                    "media_release_prerequisite_unmet",
                    "trusted media release prerequisites changed after staging",
                    blockers=blockers,
                )
            return self._switch_locked(
                state,
                transaction_id=transaction_id,
                operation="upgrade",
                desired=candidate,
                restore_target=current,
                previous_after_success=current,
            )

    def start(self, *, transaction_id: str) -> dict[str, object]:
        self._validate_transaction_id(transaction_id)
        with self._locked():
            state = self._read_state()
            self._require_no_transaction(state)
            active = state["active"]
            if active is None:
                raise MediaReleaseError("media_release_not_installed", "no trusted media release is installed")
            blockers = tuple(self._admission_check(active))
            if blockers:
                raise MediaReleaseError(
                    "media_release_prerequisite_unmet",
                    "trusted media release no longer satisfies admission",
                    blockers=blockers,
                )
            if state["activeRunning"] is True:
                return self._copy(state)
            state["transaction"] = self._transaction(transaction_id, "start", active, None, active)
            self._write_state(state)
            try:
                self._runtime.start(active)
                if not self._runtime.wait_healthy(active, int(active["healthTimeoutSeconds"])):
                    raise MediaReleaseError("media_release_health_failed", "trusted media service did not become healthy")
                state["activeRunning"] = True
                state["generation"] += 1
                state["transaction"] = None
                state["lastFailureCode"] = None
                self._write_state(state)
                return self._copy(state)
            except Exception as error:
                try:
                    self._quiesce(active, remove=False)
                except Exception as cleanup_error:
                    self._mark_recovery_required_locked(state)
                    raise MediaReleaseError(
                        "media_release_recovery_incomplete",
                        "failed media release start could not be quiesced exactly",
                    ) from cleanup_error
                state["activeRunning"] = False
                state["transaction"] = None
                state["lastFailureCode"] = self._error_code(error)
                self._write_state(state)
                raise self._lifecycle_error("media_release_start_failed", error) from error

    def stop(self, *, transaction_id: str) -> dict[str, object]:
        self._validate_transaction_id(transaction_id)
        with self._locked():
            state = self._read_state()
            self._require_no_transaction(state)
            active = state["active"]
            if active is None or state["activeRunning"] is False:
                return self._copy(state)
            state["transaction"] = self._transaction(transaction_id, "stop", None, active, active)
            self._write_state(state)
            try:
                self._quiesce(active, remove=False)
                state["activeRunning"] = False
                state["generation"] += 1
                state["transaction"] = None
                state["lastFailureCode"] = None
                self._write_state(state)
                return self._copy(state)
            except Exception as error:
                self._mark_recovery_required_locked(state)
                raise MediaReleaseError(
                    "media_release_recovery_incomplete",
                    "trusted media release stop did not quiesce exactly",
                ) from error

    def rollback(self, *, transaction_id: str) -> dict[str, object]:
        self._validate_transaction_id(transaction_id)
        with self._locked():
            state = self._read_state()
            self._require_no_transaction(state)
            desired = state["previous"]
            current = state["active"]
            if desired is None:
                raise MediaReleaseError("media_release_rollback_unavailable", "no previous exact media release exists")
            blockers = tuple(self._admission_check(desired))
            if blockers:
                raise MediaReleaseError(
                    "media_release_prerequisite_unmet",
                    "previous media release no longer satisfies admission",
                    blockers=blockers,
                )
            return self._switch_locked(
                state,
                transaction_id=transaction_id,
                operation="rollback",
                desired=desired,
                restore_target=current,
                previous_after_success=current,
            )

    def uninstall(self, *, transaction_id: str) -> dict[str, object]:
        self._validate_transaction_id(transaction_id)
        with self._locked():
            state = self._read_state()
            self._require_no_transaction(state)
            active = state["active"]
            if active is None:
                return self._copy(state)
            state["transaction"] = self._transaction(transaction_id, "uninstall", None, active, active)
            self._write_state(state)
            try:
                releases = self._unique_releases(active, state["previous"], state["staged"])
                self._quiesce_releases(releases, remove=True)
                clean = self._empty_state()
                clean["generation"] = state["generation"] + 1
                self._write_state(clean)
                return self._copy(clean)
            except Exception as error:
                self._mark_recovery_required_locked(state)
                raise MediaReleaseError(
                    "media_release_recovery_incomplete",
                    "trusted media release uninstall did not clean every exact release",
                ) from error

    def recover(self) -> dict[str, object]:
        with self._locked():
            state = self._read_state()
            if state["transaction"] is None:
                return self._copy(state)
            return self._copy(self._recover_locked(state))

    def status(self) -> dict[str, object]:
        with self._locked():
            return self._copy(self._read_state())

    def _switch_locked(
        self,
        state: dict[str, object],
        *,
        transaction_id: str,
        operation: str,
        desired: Mapping[str, object],
        restore_target: Mapping[str, object] | None,
        previous_after_success: Mapping[str, object] | None,
    ) -> dict[str, object]:
        state["transaction"] = self._transaction(
            transaction_id,
            operation,
            desired,
            restore_target,
            restore_target,
        )
        self._write_state(state)
        try:
            if restore_target is not None and state["activeRunning"] is True:
                self._quiesce(restore_target, remove=False)
            state["transaction"]["phase"] = "starting-candidate"
            self._write_state(state)
            self._runtime.start(desired)
            if not self._runtime.wait_healthy(desired, int(desired["healthTimeoutSeconds"])):
                raise MediaReleaseError("media_release_health_failed", "candidate media release did not become healthy")
            state["active"] = dict(desired)
            state["activeRunning"] = True
            state["previous"] = dict(previous_after_success) if previous_after_success is not None else None
            state["staged"] = None
            state["transaction"] = None
            state["degraded"] = False
            state["lastFailureCode"] = None
            state["generation"] += 1
            self._write_state(state)
            return self._copy(state)
        except Exception as error:
            try:
                self._quiesce(desired, remove=True)
            except Exception as cleanup_error:
                self._mark_recovery_required_locked(state)
                raise MediaReleaseError(
                    "media_release_recovery_incomplete",
                    "failed candidate media release could not be removed exactly",
                ) from cleanup_error
            return self._restore_after_failure_locked(state, error, "media_release_activation_failed")

    def _restore_after_failure_locked(
        self,
        state: dict[str, object],
        original_error: Exception,
        failure_code: str,
    ) -> dict[str, object]:
        transaction = state.get("transaction") or {}
        restore_target = transaction.get("restoreTarget")
        try:
            if restore_target is not None:
                self._runtime.start(restore_target)
                if not self._runtime.wait_healthy(restore_target, int(restore_target["healthTimeoutSeconds"])):
                    raise MediaReleaseError("media_release_restore_health_failed", "previous media release did not recover")
            state["active"] = dict(restore_target) if restore_target is not None else None
            state["activeRunning"] = restore_target is not None
            state["staged"] = None
            state["transaction"] = None
            state["degraded"] = False
            state["lastFailureCode"] = self._error_code(original_error)
            state["generation"] += 1
            self._write_state(state)
        except Exception as restore_error:
            state["activeRunning"] = False
            state["degraded"] = True
            state["lastFailureCode"] = "media_release_recovery_incomplete"
            if isinstance(state.get("transaction"), dict):
                state["transaction"]["phase"] = "recovery-required"
            self._write_state(state)
            raise MediaReleaseError(
                "media_release_recovery_incomplete",
                "candidate failed and the previous exact media release could not be restored",
            ) from restore_error
        raise self._lifecycle_error(failure_code, original_error) from original_error

    def _recover_locked(self, state: dict[str, object]) -> dict[str, object]:
        transaction = state["transaction"]
        desired = transaction.get("desired")
        restore_target = transaction.get("restoreTarget")
        try:
            # A crashed start transaction must roll back to the already
            # installed-but-stopped identity.  It must neither remove that
            # release nor forget it merely because the runtime start was
            # interrupted before the health/commit point.
            if transaction.get("operation") == "start":
                if desired is not None:
                    self._quiesce(desired, remove=False)
                prior_active = transaction.get("priorActive")
                state["active"] = dict(prior_active) if prior_active is not None else None
                state["activeRunning"] = False
                state["transaction"] = None
                state["degraded"] = False
                state["lastFailureCode"] = "media_release_interrupted_rolled_back"
                state["generation"] += 1
                self._write_state(state)
                return state
            # Stop recovery completes the requested quiesce.  Re-running the
            # full idempotent safety sequence is required even when a prior
            # attempt appeared to stop the process: a lost acknowledgement for
            # discovery withdrawal or ephemeral-state destruction is not proof
            # that either operation completed.
            if transaction.get("operation") == "stop":
                if restore_target is None:
                    raise MediaReleaseError(
                        "media_release_state_invalid",
                        "interrupted stop has no exact installed release",
                    )
                self._quiesce(restore_target, remove=False)
                state["active"] = dict(restore_target)
                state["activeRunning"] = False
                state["transaction"] = None
                state["degraded"] = False
                state["lastFailureCode"] = "media_release_interrupted_completed"
                state["generation"] += 1
                self._write_state(state)
                return state
            # Uninstall recovery likewise completes exact removal instead of
            # silently restarting a release whose state-clear/remove result was
            # unknown at the crash boundary.
            if transaction.get("operation") == "uninstall":
                self._quiesce_releases(
                    self._unique_releases(state["active"], state["previous"], state["staged"]),
                    remove=True,
                )
                clean = self._empty_state()
                clean["generation"] = state["generation"] + 1
                clean["lastFailureCode"] = "media_release_interrupted_completed"
                self._write_state(clean)
                return clean
            if desired is not None:
                self._quiesce(desired, remove=True)
            if restore_target is not None:
                # A previous restore attempt may have started only part of the
                # release set or lost its acknowledgement before the journal
                # could commit.  Re-quiesce the exact prior identity before
                # starting it again so recovery cannot duplicate an SFU,
                # receiver, reservation or discovery advertisement.
                self._quiesce(restore_target, remove=False)
                self._runtime.start(restore_target)
                if not self._runtime.wait_healthy(restore_target, int(restore_target["healthTimeoutSeconds"])):
                    raise MediaReleaseError("media_release_restore_health_failed", "recovered release is unhealthy")
            state["active"] = dict(restore_target) if restore_target is not None else None
            state["activeRunning"] = restore_target is not None
            state["staged"] = None
            state["transaction"] = None
            state["degraded"] = False
            state["lastFailureCode"] = "media_release_interrupted_rolled_back"
            state["generation"] += 1
            self._write_state(state)
            return state
        except Exception as error:
            state["activeRunning"] = False
            state["degraded"] = True
            state["lastFailureCode"] = "media_release_recovery_incomplete"
            transaction["phase"] = "recovery-required"
            self._write_state(state)
            raise MediaReleaseError(
                "media_release_recovery_incomplete",
                "interrupted media release transaction cannot restore its prior identity",
            ) from error

    def _mark_recovery_required_locked(self, state: dict[str, object]) -> None:
        """Persist an unknown cleanup outcome without claiming rollback.

        Once any quiesce/remove acknowledgement is missing, the controller
        cannot truthfully advertise the active release as running or clear the
        durable transaction.  ``recover`` will replay the exact idempotent
        safety sequence under the same lock.
        """

        state["activeRunning"] = False
        state["degraded"] = True
        state["lastFailureCode"] = "media_release_recovery_incomplete"
        transaction = state.get("transaction")
        if isinstance(transaction, dict):
            transaction["phase"] = "recovery-required"
        self._write_state(state)

    def _quiesce(self, release: Mapping[str, object], *, remove: bool) -> None:
        # Cleanup is a safety sequence, not a short-circuit pipeline.  A failed
        # advertisement withdrawal must not leave the processes, ephemeral
        # state, or reservation untouched; likewise, a stop failure must not
        # prevent credential/state destruction.  Retain the first stable error
        # only after every applicable bounded operation has been attempted.
        failures: list[Exception] = []
        operations = [
            self._runtime.withdraw_discovery,
            self._runtime.stop,
            self._runtime.clear_ephemeral_state,
        ]
        if remove:
            operations.append(self._runtime.remove)
        for operation in operations:
            try:
                operation(release)
            except Exception as error:
                failures.append(error)
        if failures:
            first = failures[0]
            if isinstance(first, MediaReleaseError):
                raise first
            raise MediaReleaseError(
                "media_release_quiesce_incomplete",
                "trusted media release cleanup did not complete",
            ) from first

    def _quiesce_releases(self, releases: Sequence[Mapping[str, object]], *, remove: bool) -> None:
        """Attempt the safety sequence for every exact release identity.

        Uninstall can own an active, previous and staged identity at the same
        time.  One failed acknowledgement must retain recovery-required state,
        but it must not prevent best-effort cleanup of the other exact owned
        identities.  The durable transaction is cleared only after every
        release reports success in the same locked attempt.
        """

        failures: list[Exception] = []
        for release in releases:
            try:
                self._quiesce(release, remove=remove)
            except Exception as error:
                failures.append(error)
        if failures:
            first = failures[0]
            if isinstance(first, MediaReleaseError):
                raise first
            raise MediaReleaseError(
                "media_release_quiesce_incomplete",
                "trusted media release cleanup did not complete",
            ) from first

    @staticmethod
    def _transaction(
        transaction_id: str,
        operation: str,
        desired: Mapping[str, object] | None,
        restore_target: Mapping[str, object] | None,
        prior_active: Mapping[str, object] | None,
    ) -> dict[str, object]:
        return {
            "transactionId": transaction_id,
            "operation": operation,
            "phase": "prepared",
            "desired": dict(desired) if desired is not None else None,
            "restoreTarget": dict(restore_target) if restore_target is not None else None,
            "priorActive": dict(prior_active) if prior_active is not None else None,
        }

    @staticmethod
    def _empty_state() -> dict[str, object]:
        return {
            "schemaVersion": 1,
            "generation": 0,
            "active": None,
            "activeRunning": False,
            "previous": None,
            "staged": None,
            "transaction": None,
            "degraded": False,
            "lastFailureCode": None,
        }

    def _read_state(self) -> dict[str, object]:
        try:
            document = json.loads(self._state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise MediaReleaseError("media_release_state_invalid", "media release state cannot be read") from error
        stored_digest = document.pop("stateDigest", None)
        if stored_digest != _digest(document):
            raise MediaReleaseError("media_release_state_invalid", "media release state integrity check failed")
        self._validate_state(document)
        return document

    def _write_state(self, state: Mapping[str, object]) -> None:
        document = self._copy(state)
        self._validate_state(document)
        document["stateDigest"] = _digest(document)
        payload = _canonical(document) + b"\n"
        descriptor, temporary_name = tempfile.mkstemp(prefix="release-state.", suffix=".next", dir=self._root)
        try:
            os.fchmod(descriptor, 0o600)
            with os.fdopen(descriptor, "wb", closefd=True) as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_name, self._state_path)
            directory = os.open(self._root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass

    @staticmethod
    def _validate_state(state: Mapping[str, object]) -> None:
        expected = {
            "schemaVersion",
            "generation",
            "active",
            "activeRunning",
            "previous",
            "staged",
            "transaction",
            "degraded",
            "lastFailureCode",
        }
        if set(state) != expected or state.get("schemaVersion") != 1:
            raise MediaReleaseError("media_release_state_invalid", "media release state shape changed")
        generation = state.get("generation")
        if not isinstance(generation, int) or isinstance(generation, bool) or generation < 0:
            raise MediaReleaseError("media_release_state_invalid", "media release generation is invalid")
        for key in ("active", "previous", "staged"):
            value = state.get(key)
            if value is not None:
                _public_release(value)
        if state.get("active") is None and state.get("activeRunning") is not False:
            raise MediaReleaseError("media_release_state_invalid", "missing release cannot be running")
        if not isinstance(state.get("activeRunning"), bool) or not isinstance(state.get("degraded"), bool):
            raise MediaReleaseError("media_release_state_invalid", "media release flags are invalid")
        transaction = state.get("transaction")
        if transaction is not None:
            required = {"transactionId", "operation", "phase", "desired", "restoreTarget", "priorActive"}
            if set(transaction) != required:
                raise MediaReleaseError("media_release_state_invalid", "media release journal shape changed")
            MediaReleaseController._validate_transaction_id(str(transaction.get("transactionId", "")))
            if transaction.get("operation") not in {"activate", "upgrade", "start", "stop", "rollback", "uninstall"}:
                raise MediaReleaseError("media_release_state_invalid", "media release journal operation is invalid")
            if transaction.get("phase") not in {"prepared", "starting-candidate", "recovery-required"}:
                raise MediaReleaseError("media_release_state_invalid", "media release journal phase is invalid")
            for key in ("desired", "restoreTarget", "priorActive"):
                value = transaction.get(key)
                if value is not None:
                    _public_release(value)
        failure = state.get("lastFailureCode")
        if failure is not None and (not isinstance(failure, str) or not re.fullmatch(r"[a-z0-9_]{1,96}", failure)):
            raise MediaReleaseError("media_release_state_invalid", "media release failure code is invalid")

    @contextmanager
    def _locked(self):
        self._root.mkdir(parents=True, exist_ok=True, mode=0o700)
        descriptor = os.open(self._lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    @staticmethod
    def _require_no_transaction(state: Mapping[str, object]) -> None:
        if state.get("transaction") is not None:
            raise MediaReleaseError("media_release_recovery_required", "an interrupted media release transaction must recover first")

    @staticmethod
    def _validate_transaction_id(value: str) -> None:
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{2,95}", value):
            raise MediaReleaseError("media_release_transaction_invalid", "media release transaction identity is invalid")

    @staticmethod
    def _unique_releases(*releases: Mapping[str, object] | None) -> list[Mapping[str, object]]:
        result: list[Mapping[str, object]] = []
        seen: set[str] = set()
        for release in releases:
            if release is None:
                continue
            digest = str(release["trustedMediaImageDigest"])
            if digest not in seen:
                seen.add(digest)
                result.append(release)
        return result

    @staticmethod
    def _copy(value: object):
        return json.loads(json.dumps(value))

    @staticmethod
    def _error_code(error: Exception) -> str:
        code = getattr(error, "code", None)
        return code if isinstance(code, str) and re.fullmatch(r"[a-z0-9_]{1,96}", code) else "media_release_runtime_error"

    @staticmethod
    def _lifecycle_error(code: str, error: Exception) -> MediaReleaseError:
        if isinstance(error, MediaReleaseError):
            return MediaReleaseError(code, str(error), blockers=error.blockers)
        return MediaReleaseError(code, "trusted media lifecycle operation failed")

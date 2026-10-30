# Appliance runtime restart policy v1

This policy enables the Node Agent's bounded `appliance.runtime.restart`
command. It does not expose a general container restart API. The command body
contains no container name or Docker action; both targets are fixed by this
deployment-owned document.

## Deployment inputs

Mount one regular, non-symlink policy file read-only into the Node Agent. The
file must not be group- or world-writable. A root-owned `0444` file is the
recommended host representation.

Configure both variables or neither:

- `TEAMAIBOX_APPLIANCE_RESTART_POLICY_FILE`: bounded absolute in-container path
  of the read-only policy file.
- `TEAMAIBOX_APPLIANCE_RESTART_POLICY_DIGEST`: SHA-256 of the exact serialized
  policy file, including its final newline, formatted as `sha256:<64 hex>`.

The existing `TEAMAIBOX_NODE_STATE_DIR` mount must remain durable and writable
by UID/GID 10001. The coordinator writes
`appliance-restart-journal.v1.json` there with mode `0600`, atomically fsyncs
the file and parent directory before the first Docker mutation, and recovers
only an exact journal replay. The production Agent also needs its existing
Docker Engine socket mount; the implementation calls the Engine HTTP API and
does not invoke a shell or Docker CLI.

Each `platform` and `nodeAgent` target fixes:

- exact container name;
- exact local image configuration ID;
- exact `Config.Image` reference;
- exact normalized runtime configuration digest; and
- mandatory Docker health status `healthy`.

The normalized configuration digest covers the same immutable inspect facts as
the legacy protected-set runtime digest. Only the values of the two policy
locator variables above, the Node Agent's self-referential
`TEAMAIBOX_APPLIANCE_CONFIGURATION_DIGEST`, the Platform's
`PLATFORM_PROTECTED_OFFICE_SET_RESTART_POLICY_DIGEST` semantic binding, and the
self-referential `com.teamaibox.config-digest` label are replaced by fixed
sentinels before hashing. This breaks the otherwise circular
dependency between both runtime configurations and the policy artifact; the
Agent loader independently checks the exact policy-file digest, while Platform
commands carry the policy document's semantic `policyDigest`. These two digests
must never be substituted for one another. The container ID is deliberately
observed rather than predeclared,
because Docker assigns it only after create. The fsynced journal captures the
full pre-restart ID and completion requires the same ID after restart.

`TEAMAIBOX_APPLIANCE_IMAGE_DIGEST` is not redacted: it has no circular dependency
and remains covered by the normalized runtime digest. The appliance configuration
value is accepted only when it equals that normalized runtime digest, allowing
the signed `appliance.inspect` operation to expose the exact local Agent identity
without substituting a mutable tag or an unrelated deployment artifact.

`policyDigest` is the SHA-256 of Go's canonical JSON representation of the
typed policy after setting `policyDigest` to the empty string. It binds the
semantic policy in every command independently of the exact file digest.

## Command and replay

The authenticated mTLS/HMAC command type is `appliance.runtime.restart`. Its
payload is exactly:

```json
{
  "restartId": "<same UUID as commandId and leaseId>",
  "journalRevision": 1,
  "policyDigest": "sha256:<semantic policy digest>",
  "idempotencyKey": "sha256:<controller idempotency key>"
}
```

`journalRevision` must equal the envelope fencing token and `idempotencyKey`
must equal the envelope idempotency value. The first accepted call returns
`restart-required` after the Platform has restarted and passed exact identity
and health verification, and after the Node Agent self-restart has been
durably armed. A controller then waits for the same Node Agent container to
become healthy with a later `StartedAt` and replays the exact signed command.
That replay returns `succeeded` with exact pre/post container IDs, image IDs,
image references, configuration digests, timestamps, and journal revisions.

# Virtual-computer installation API

New routes extend `/api/v1/virtual-computers`; they do not change guest disk
identity or grant host-media access to monitor invitees. Normal platform session,
CSRF and `computer:use` authorization apply. All responses use `no-store`.
An authenticated administrator is not automatically the owner of another member's
computer or installation media.

## Installation library

| Method and suffix | Request | Response |
| --- | --- | --- |
| `GET /installation-media` | none | `{data:[media]}` owned by this member |
| `GET /installation-media/:mediaId` | none | one owned media record |
| `POST /installation-media` | `source:"upload", name, referenceId` or `source:"drive", name, fileId, version` | durable preparing/existing media record |
| `DELETE /installation-media/:mediaId` | `expectedRevision, confirmDelete:true` | deletion state; referenced media is refused |

Import POST requires an `Idempotency-Key`; the same request returns the original
record. A different request under that key conflicts. `fileId` identifies a drive
file and `version` pins its immutable integer version. Permissions are checked
again for a new import. Copy completion is asynchronous; poll the returned ID.

Local upload uses existing `/api/v1/objects/multipart` with capability
`virtual_computer`, per-part hashes, completion and owner-scoped object references.
`packages/plugin-sdk/src/installation-upload.mjs` retains only transfer metadata
in local storage. After reselecting the same file it validates the digest and
reconciles completed parts. Cancellation aborts uncommitted server parts; a lost
completion reply is reconciled before another upload is attempted.

Public media fields are `id,name,state,revision,source,size,copiedBytes,
compatibility,errorCode`. They do not expose host paths, storage credentials or
cross-user object references. Compatibility is `arm64`, `unverified`,
`wrong-architecture`, `not-bootable` or `invalid`; successful upload is not an OS
compatibility or licence claim. `unverified` requires explicit confirmation.

## Computer installation controls

`GET /:computerId/installation` returns `supported,installation,computerRevision,
canAdopt,reasonCode`. An absent installation row means legacy, not an empty disk.
Installation state includes desired/observed media IDs and revisions, pending
operation ID, `autoStart`, an error code and an optional generation-bound boot
request. Pending media and runtime-confirmed media must be shown distinctly.

All following POSTs require `Idempotency-Key` and `expectedRevision`:

| Suffix | Additional input | Effect |
| --- | --- | --- |
| `/:computerId/installation/mount` | `mediaId`, optional `allowUnverified` | stage verified bytes and change only installer media |
| `/:computerId/installation/eject` | none | non-forced installer eject |
| `/:computerId/installation/boot-disc` | none | schedule next power-on once; no immediate restart |
| `/:computerId/installation/cancel-boot` | none | cancel an unconsumed pending intent |
| `/:computerId/installation/installed` | none | owner says installation finished; not an OS health probe |
| `/:computerId/installation/adopt` | none | on a stopped legacy computer, enable installed compatible runtime/media controls without rewriting disk identity |

For `adopt`, use the returned **computerRevision**. Other actions use the
**installation.revision**. Optical changes use the persistent operation worker;
boot intent and owner confirmation use the same durable operation identity but
can finish without guest execution. Read `/operations/:operationId` to reconcile
an accepted request. A response loss must not create another computer or restart
the installer. `202` means accepted, not necessarily finished.

Typical errors: `computer_state_conflict` (refresh revision),
`computer_operation_pending` (wait for the existing operation),
`computer_media_confirmation_required` (explicitly confirm unverified media),
`computer_media_wrong_architecture`, `computer_media_not_bootable`,
`computer_media_in_use`, `computer_optical_locked`,
`computer_installation_upgrade_required` and `computer_capacity_unavailable`.
Uncertain transport failures remain reconcilable, not a successful eject or a
reason to delete the guest. A definite fresh staging-capacity refusal completes
with failure; after space is available, a new revision/key can retry.

## Create and install

Existing create input remains supported. For a schema-2 Windows/Linux hardware
profile, POST the existing name/profile/resources fields, optionally adding
`installationMediaId` and `allowUnverified`. With no media this creates an empty
computer. With media, durable follow-up performs mount → next-disc boot → start.
It retains the same computer on failure; no copy of an installed guest is made.
Closing the browser does not cancel accepted work. A running computer is never
automatically restarted by the follow-up worker.

The monitor remains the existing authenticated console. Media changes do not
modify its sharing, sound or remote-desktop authorization. The UI directs users
to save and normally shut down a running guest before a requested disc startup.

## Evidence and rollout

See [incremental implementation and deployment record](validation/computer-installation-media-20261023.md).
New-profile publication and actual installer acceptance are tracked separately
from fixture/API tests. Never run a schema down migration to erase used media or
installation records during an application rollback.

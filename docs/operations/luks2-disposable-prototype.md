# Disposable LUKS2 prototype

Task 13.2 is validated only against a sparse regular file below the exact
`/tmp/teamaibox-luks-prototype-*` prefix. The runner has no device-path option,
rejects unsafe run IDs and pre-existing work paths, and never discovers or
selects an NVMe partition. It requires the existing host `cryptsetup`, ext4,
device-mapper, mount, and unmount boundary; it installs nothing.

The prototype creates separate automatic, offline-recovery, and Web test
factors, records LUKS2 key-slot metadata, unlocks and formats the disposable
mapper, writes a non-sensitive sentinel, explicitly unmounts and closes it,
rotates the automatic factor, proves the old factor fails, revokes the Web
factor, and recovers the sentinel through the offline factor. Key bytes and
passphrases are never printed or retained in evidence. The exact mapper,
temporary key files, sparse image, and staging directory are removed before a
passing result is returned.

The original remote orchestration runner has been retired. Its dated results
remain historical records, not an installation command or permission to touch
an existing disk. Current local storage maintenance is documented in
[local storage maintenance](../../deploy/android/cuttlefish/local-storage-maintenance.md).
It validates the same-device plan and keeps guest data separate from temporary
prototype files. No test may select or format a live disk automatically.

A pass from this prototype is not permission
to migrate the development or production NVMe. Real-media migration remains
blocked until a separately reviewed data-preserving migration, console recovery,
power-failure, and rollback runbook is complete.

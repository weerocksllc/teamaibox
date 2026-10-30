# Security and startup unlock runbook

## Encryption and startup protection

Team AI Box uses service-level encrypted objects/secrets. LUKS2 block protection
is optional in the product requirements; the maintained fresh-install recipe
prepares a LUKS2 data volume. Inspect the actual installation rather than
assuming an existing device was migrated. Startup Unlock Protection is optional
and off by default to preserve unattended appliance startup.

With Startup Unlock Protection off, a protected automatic factor opens the
LUKS2 data volume during boot. With it on, protected services remain stopped
until an administrator enters the startup passphrase in the trusted Web
Unlock Service. This mode does
not create a second unencrypted data path.

## Web passphrase mode

The minimal Unlock Service runs in Docker before the protected data root is
mounted. Use only its pinned HTTPS origin and verify the certificate
fingerprint. The service accepts a passphrase into locked process memory where
supported, sends it only to the constrained unlock adapter, rate limits and
audits attempts without recording the secret, zeroes buffers, and never stores
it in browser storage, logs, environment, command arguments, or the platform
database.

After unlock, verify the exact LUKS UUID, mapper, filesystem UUID, mount options
and protected layout before starting other services. A successful cryptsetup
exit with the wrong device/mount is failure. Close the unlock surface or reduce
it to status after protected services start.

## Retired hardware-key integration

USB Key / ViKey is no longer a product feature. Removal of its SDK does not
delete existing encrypted data, recovery material or key slots. Historical
hardware-mode records are read-only and must never be treated as automatic
unlock. An older installation using that mode requires its existing offline
recovery factor and a verified Web passphrase before changing boot policy.

## Enable, disable, and rotate

Changing startup protection is administrator-only, audited, and guarded by a
verified offline recovery factor, LUKS2 header backup, console/recovery path, power stability,
exact device/key-slot inventory, and typed confirmation. Enabling first enrolls
and tests the new Web passphrase factor before removing automatic unlock. Disabling
first enrolls and tests the replacement automatic factor. Never combine the
change with disk formatting, data migration, OS/driver update, or key rotation.

Rotate one key slot at a time. Add and test the new factor, update protected
recovery records, take a new header backup, then remove the old slot. Keep an
independent offline recovery factor. A sole key, a header backup stored only on
the same NVMe, or an untested recovery code is a stop condition.

## Lost factor, removal, and emergency recovery

- Lost Web passphrase: keep services/data closed and use the separately stored
  offline recovery factor through the staffed local recovery procedure.
- Different LUKS UUID/header digest/key-slot inventory: stop, do not retry slot
  deletion or formatting, and preserve the device for review.
- Suspected plaintext/key exposure: fence service and provider credentials,
  preserve audit evidence, rotate affected wrapping/recovery keys through a
  verified key-rotation procedure, and assess all exported artifacts.

Emergency recovery is local and separately controlled; it does not create a
hidden administrator or remote bypass. Boot the tested recovery environment,
identify media by serial/WWN/PARTUUID and LUKS UUID, authenticate the header and
offline factor, mount read-only first, verify data integrity and key-slot evidence before controlled service recovery. Never run repair against the sole copy.

## Security verification

After every unlock-policy or key change, reboot once with recovery staff
present and verify locked-state denial, both intended factors, exact mount identity, non-root bounded containers, HTTPS
session/CSRF behavior, object encryption, audit chain, one queued job, core
services, and recovery-factor availability. Record closed
digests and outcomes, not secrets.

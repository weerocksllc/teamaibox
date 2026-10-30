# Physical-space-bounded guest storage

File-backed local guest pools use elastic address space rather than a fixed
256/384 GiB aggregate allocation. Keep the existing unlocked LUKS mapping,
filesystem UUID, project quota records and individual guest disk sizes.

The root-installed `phone-storage-helper` configuration accepts
`elasticBackingFile` and `elasticKeyFile` alongside the existing pool identity.
Both must be absolute installed paths. The backing file must be the exact file
of the verified pool's loop device; the key is the existing private root-owned
64-byte key. Never embed key bytes in config, logs, browser requests or Git.

On a capacity observation, the helper extends sparse address space to the
backing filesystem's size, then grows the loop, existing encrypted mapping and
filesystem online. It does not format, unmount, create a new pool, or preallocate
the entire appliance. Interrupted extension is completed on a later observation.
Available bytes are `min(pool free, physical backing free)`; existing unwritten
guest commitments and operating margin are still subtracted by admission.
There is no product-wide fixed guest-pool capacity ceiling.

The storage service needs write access to that exact backing file and
`/run/cryptsetup`, plus its existing device/filesystem capabilities. Existing
LUKS Argon2 parameters determine temporary key-check memory: provision enough
service memory for them (the deployed pool uses a 1 GiB KDF, with a 2 GiB service
ceiling). Do not weaken the KDF or remove encryption to work around this.
The private `.elastic-growth.lock` is separate from the backing inode because
cryptsetup locks that inode itself. Do not add this service as a Docker
`Requires` dependency: replacing the helper must not restart unrelated guests.

`tools/deploy_elastic_guest_storage_20261024.py` is the bounded migration for the
existing appliance. Its before/result artifacts preserve the previous helper
and config and compare Docker process and guest bindings. Treat its exact paths
as that installation's identity, not a reusable default for a different box.

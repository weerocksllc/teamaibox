# Protected secrets

Platform-owned abstraction for encrypted secret records, scoped service
access, redacted metadata, rotation history, and safe audit events. Secret
consumers receive plaintext only inside a bounded callback and permanent
backends store ciphertext, nonce, tag, and non-secret metadata.

The filesystem ciphertext backend is suitable for the single-writer appliance
control-plane foundation when its directory is on protected appliance storage.
The 32-byte master key must come from a separate provider; it is never stored
beside ciphertext.

`loadDevelopmentMasterKey` is deliberately gated by both development
runtime and an explicit allow flag. It rejects symlinks, non-regular files,
group/world permissions, and keys of the wrong size. It is not a production
automatic-unlock implementation.

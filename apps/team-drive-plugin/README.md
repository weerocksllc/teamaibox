# Team Drive ApplicationPlugin

The official Team Drive is a non-root, read-only browser ApplicationPlugin. It
uses delegated same-origin file and protected-object APIs; the container has no
database, object-store, host filesystem, Docker socket, device, or external
network access.

Small uploads use one-shot verified object upload. Files above 32 MiB use
16 MiB verified multipart chunks. Resume state contains only a server upload ID,
file fingerprint, digest, and verified part facts in browser local storage—never
session tokens, object credentials, or plaintext file content. The server is the
authority for which chunks may be skipped on resume.

Run `node --test apps/team-drive-plugin/test/*.test.mjs` from the repository root.

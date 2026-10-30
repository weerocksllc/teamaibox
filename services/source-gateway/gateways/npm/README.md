# NPM gateway adapter

NPM registry protocol adapter. Policy and credentials come from Source Center;
this adapter owns protocol compatibility and package-byte flow only.

The gateway implements the NPM install packument described by the official
[registry package-metadata contract](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md).
It serves normal and scoped packages, version manifests, local immutable
tarball URLs, `dist.integrity` SHA-512 SRI, legacy `shasum`, dependencies,
optional/peer dependencies, engines, CPU/OS compatibility, deprecation and
install-script metadata. A current real NPM client installation runs in the
automated tests.

Hosted and offline imports verify size, SHA-512, SHA-256 and SHA-1 before
publication. Proxy metadata uses the abbreviated install representation;
credentials are resolved only inside the HTTPS upstream adapter, redirects and
unapproved tarball origins fail closed, and inspection must explicitly return a
scan/signature result. Tarballs are verified before cache publication and again
on every cached read.

Source Center priority, scopes, team/sandbox/architecture selection,
allow/deny and version pins are applied before metadata or bytes are returned.
The offline availability endpoint traverses required packages with bounded
SemVer evaluation and identifies each missing transitive package. Migration 36
persists package/integrity/platform metadata; production tarball bytes remain
behind the protected content-store boundary.

# APT gateway adapter

APT repository/proxy protocol adapter for sandbox and build environments.
Host maintenance repositories are deliberately outside this data plane.

The adapter implements the Debian archive layout documented by the official
[Debian Repository Format](https://wiki.debian.org/DebianRepository/Format):
`dists/<suite>/InRelease`, ARM64 `Packages`, SHA-256 by-hash indices, and
verified pool downloads. It emits only `arm64` and `all` packages into internal
snapshots, includes `Valid-Until`, and refuses to publish unless the generated
OpenPGP clear-signed Release verifies against the exact configured signing-key
fingerprint.

The OpenPGP adapter runs fixed, non-networked `gpg` commands behind a container
executor; the source service never executes a shell or handles private key
bytes. External synchronization first verifies the upstream InRelease with its
source-specific trust adapter, then verifies the signed Packages size/SHA-256,
filters ARM64 stanzas, and validates every package URL. Internal snapshots are
signed again because their filenames and policy-selected contents differ from
the upstream archive.

Hosted/offline `.deb` imports and proxy downloads verify SHA-256 before cache
publication and on every read. Source priorities, scopes, deny/pin rules and
offline mode apply to snapshots and package downloads. A bounded Debian
dependency parser tracks `Pre-Depends`, `Depends`, alternatives and version
constraints for full offline-availability reports. Migration 37 persists
package metadata and append-only signed snapshot evidence.

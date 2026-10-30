# Pip gateway adapter

Pip Simple API protocol adapter. Policy and credentials come from Source
Center; this adapter owns protocol compatibility and package-byte flow only.

The gateway serves both the current JSON serialization and legacy/frozen HTML
serialization of the [PyPA Simple Repository API](https://packaging.python.org/en/latest/specifications/simple-repository-api/).
It reports repository API version 1.4, publishes SHA-256 hashes in every file
link, exposes `Requires-Python`, yanked state, core-metadata hashes, immutable
download URLs, and keeps compatibility with older PIP clients that require the
`text/html` media type. A real PIP client installation is part of the automated
test suite.

`PipGatewayService` applies the resolved Source Center policy before listing or
downloading any artifact. It enforces source priority and package scope,
deny/version-pin rules, ARM64 compatibility, offline requirements, inspection
state, signatures, and checksum verification. Hosted and offline imports are
verified before catalog publication. Proxy downloads verify both declared byte
length and SHA-256 before entering the cache; cached bytes are reverified on
every read and corrupt content fails closed.

The HTTPS JSON upstream adapter accepts only approved origins, disables
redirects, retrieves protected authorization headers without returning them,
verifies PEP 658 core metadata, and indexes `Requires-Dist` dependency facts.
The availability endpoint walks the verified transitive graph and returns each
missing artifact with an actionable reason. Metadata is persisted by migration
35; package bytes are behind the content-store interface so production wiring
can bind them to protected appliance storage rather than a host path.

# Network and identity fixtures

The `10.64.0.0/24` addresses used by unit fixtures are synthetic values selected
for this test suite, not an appliance inventory. They deliberately retain
private-address and CIDR semantics for policy-validation tests. This is an
RFC 1918 range, not an IETF documentation-only allocation; tests must use mocks
and must never contact those addresses.

Public-address examples should use the RFC 5737 documentation ranges. Loopback,
multicast, unspecified addresses and generic private-range boundaries in negative
tests are protocol fixtures, not credentials.

Fixed product profile identifiers are public product identifiers. Actual node,
user, phone, installation and container identities belong in installation-owned
configuration, not captured deployment logs committed as fixtures.

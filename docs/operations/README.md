# Current single-appliance operations

Team AI Box runs its required services, protected office models, Android,
Windows and browser casting on one configured appliance. Optional external
model APIs are separate service calls, not remote device management. Start
with the current documents below; historical image, address and maintenance
records are not installation instructions.

- [Installation](installation.md)
- [Initial administrator setup](initial-admin-setup.md)
- [User guide](user-guide.md)
- [Virtual phones and camera inputs](virtual-phone-camera.md)
- [Windows 11 virtual computers](../virtual-computers-user-guide.md)
- [Browser-only wireless casting](wireless-casting-guide.md)
- [Host maintenance](host-maintenance-runbook.md)
- [Supported environments and claim limits](supported-environment-matrix.md)

## Confirmed handover — 2026-10-22

The [delivery summary](../validation/single-appliance-delivery-20261019.md)
contains the customer entry points, accepted functions, Windows installation
and redistribution boundary, Google non-certification disclosure and the project
user's explicit final acceptance. The [remaining list](../validation/remaining-work-20261019.md)
has no delivery task left in the agreed scope. Optional active-data disk migration
is not applicable and was not executed; it is not recorded as passed.
Windows 10 is not provided; Google Play and the tested physical USB camera are
completed, not deferred. Existing accepted casting results are closed.

Installation and regression runbooks are for fresh installations or affected
future changes. Do not run them again solely to update handover documents;
do not copy a signed-in phone or Windows test disk into a customer template.

## Historical attachments, not current setup

The following operational snapshots are retained under validation. Their
original bodies and underlying success/failure packets remain unchanged:

- [2026-09-07 media control-plane snapshot](../validation/trusted-media-control-plane-20260907.md)
- [2026-09-07 KMS maintenance and recovery](../validation/main-box-kms-boot-recovery-20260907.md)
- [Wireless-casting development log from 2026-09-08](../validation/wireless-casting-runtime-20260908.md)

Some original source/review attachments remain at their old paths because
historical manifests, NOTICE files or digest-bound package records reference
their exact bytes. Their location under `operations` does not make them
current runbooks. Do not replay their commands, restore their retired output
paths, use their viewer counts as product limits or inherit their acceptance:

| Preserved attachment | Meaning |
| --- | --- |
| `airplay-compatible-supply-chain-review.md` | Initial source/legal candidate review; later responsibility and release-minimum decisions are separate records |
| `trusted-media-open-source-build.v2.md` | Exact unmodified v2 receiver source/build attachment bound by its historical package |
| `trusted-media-session-pin.md` | Earlier PIN integration-stage instructions, not the current complete service or activation gate |
| `trusted-media-browser-build-20260908.md` | Dated browser-service build attachment referenced by retained source/NOTICE records |

Current casting is browser-only: no HDMI preparation, KMS change, desktop
takeover, local audio playback or additional box is required. The retained
attachments do not change that boundary. Current release artifacts need exact
current source, license/NOTICE, build and test bindings; moving documentation
or preserving an old build packet does not qualify new runtime bytes.

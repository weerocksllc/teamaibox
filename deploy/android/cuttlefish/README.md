# Android runtime on a single Team AI Box

This directory contains the ARM64 Cuttlefish runtime, reproducible input
preparation, phone storage/network helpers, and virtual-camera adapters.
These implementation names belong in developer documentation, not member UI.

The supported product topology is one appliance. Android, Windows, browser
casting, protected storage, and resident office models share its capacity.
The production composition is `deploy/appliance/production.compose.yaml`;
installation supplies the stable `PLATFORM_APPLIANCE_NODE_ID`, local Agent
identity, encrypted data root, runtime images, and installed ROM catalog.
No additional appliance, SSH enrollment, or remote camera bridge is required.

## System families and data

Members choose **Standard Android** or **Android + Google Play**. Both system
families use the same camera settings. Internal build numbers, camera adapter
revisions, and experimental image hashes do not become additional system
choices.

Base images are read-only; every phone has independent persistent writable
data. Rebuilding a web plugin or restarting its API does not replace a ROM or
reset a phone. Shutdown retains data. Deletion is a separate, explicit action.
Google services remain subject to their own terms and application compatibility;
this project does not claim Google certification or Play Integrity approval.

## Build inputs

- `inputs.lock.json` identifies the Android/host package inputs and hashes.
- `prepare_bundle.py` and `bundle_info.py` prepare and inspect the runtime
  bundle. Verify input hashes before assembly.
- `Runtime.Dockerfile` builds the phone runtime; the network, media, camera,
  and Google-image Dockerfiles build their specific adapters.
- `gapps.inputs.lock.json` and the `gapps_*.py` helpers describe Google-image
  assembly. They must not contain a signed-in user's account or writable data.
- Runtime startup uses prepared images, not an on-boot package installer or a
  dependency on an upstream CDN.

Install hardware virtualization and the required host drivers as part of the
appliance setup. Do not expose unrestricted host devices to individual phones.
Resource limits must come from the installed runtime profile and observed
capacity, not from a historical test's phone count or storage pool.

## Virtual camera

The camera chain is: selected source → bounded local capture/decoder →
per-phone frame transport → virtio-media → the Android V4L2 Camera HAL →
standard Camera2 applications. It does not require replacing an application's
camera API. Source changes do not require recreating a phone.

Sources include images, videos, the browser camera, authorized local USB
cameras, and configured UDP input. Preserve aspect ratio and timestamps; do
not accumulate an unbounded backlog when the input outruns consumption.
Stopping, permission revocation, disconnection, or source replacement clears
obsolete frames and releases the source. Camera audio is not automatically an
Android microphone; microphone support is a separate capability.

USB devices are always attached to this appliance. Browser capture requires
the browser's device permission. UDP advertises the appliance's configured LAN
address (`PLATFORM_APPLIANCE_LAN_ADDRESS`, otherwise the LAN IP in
`PLATFORM_API_PUBLIC_ORIGIN`), never an enrollment target.

## Installation and verification

### Viewer disconnects and shared display lifetime

Closing a viewer must release its operator and media connections without
restarting the phone's shared streamer. Killing that process also severs
crosvm's display/audio transports; automatically restarting the streamer does
not repair those existing transports.

`phone_media_control.py` checks sockets owned by the exact streamer before
preserving it. Its private loopback HTTP listener and operator TCP client use
ephemeral ports that can overlap the numeric media ranges. Loopback-bound TCP
sockets are therefore private infrastructure, not evidence of a lingering
browser media connection. All owned UDP sockets and non-loopback TCP media
sockets remain subject to cleanup checks, including stale media slots. Operator
browser connections, unreadable observations, process identity, and last-resort
pidfd revocation retain their existing checks. Do not replace this distinction
with a longer timeout or disable connection revocation.

For this change, verify only leaving/reopening the viewer and closing/reopening
its browser tab: the picture and input must recover, real peer sockets must
close, and the streamer must retain its process identity. The focused socket
regressions are in `tests/test_cuttlefish_phone_media_control.py`.

Deploy host-only runtime repairs with the approved ROM and maintenance policy;
retain the Android image hash and persistent volume. An existing running phone
uses its current runtime until its next normal stop/start. Never reset or
recreate a phone to upgrade its host adapter. When recreating `platform-api`,
include every registered service sharing its network namespace: `node-agent`,
`appliance-gateway`, `desktop-proxy`, `desktop-gateway`, and
`maintenance-controller`. Use the grouped namespace-upgrade path, not a partial
manual service list. Restarting a dependent does not attach it to the new
network namespace. Preserve unrelated guest containers and data.

Use the installation-supplied ROM catalog and runtime configuration together
with the appliance Compose files. Do not use a dated test image or a fixed test
IP as a deployment default.

After a runtime change, verify the affected path using a temporary phone:
create/start, view/input, stop/start with data retained, and the changed camera
source. Do not reset another phone or ask a user to log in again merely because
the front end changed. Reuse an existing authorized signed-in test phone when
account-dependent verification is needed; never copy its account into a base
image.

Current product requirements belong in OpenSpec. This source distribution does
not include historical installation results or privately retained evidence.
New verification must bind the actual installation and current source version.

- Member guide: [Virtual phones](phone-quickstart.zh-CN.md)
- Local USB camera: [Camera setup](phone-camera-usb.zh-CN.md)
- Google Play checks: [Account-dependent testing](GAPPS-TEST.md)
- Local storage and boot maintenance: [Same-appliance plans](local-storage-maintenance.md)

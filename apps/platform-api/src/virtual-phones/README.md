# Virtual phones

This module provides ordinary signed-in members with persistent Android phones
on the same Team AI Box appliance. Administrator access controls feature
availability and resource allowances, not access to another member's screen,
files, or account.

## Product boundary

The create dialog offers two system families: **Standard Android** and
**Android + Google Play**. Both expose camera settings when the installed ROM
supports the virtual-camera interface. Camera revisions are implementation
details, not additional user-facing operating systems. Google services do not
imply Google certification, Play Integrity success, DRM support, or universal
application compatibility.

Each phone has a stable owner, ID, ROM identity, and encrypted persistent data.
Closing its web page ends the viewing session, not the phone. An API or Agent
restart must reconcile the existing phone rather than clone, reset, or delete
it. A ROM upgrade is a separate explicit operation; it is never a side effect
of changing a page or rebuilding a plugin.

## Local placement and admission

Production resolves only `PLATFORM_APPLIANCE_NODE_ID`. The local Agent
endpoint is loopback-only. Android, Windows, resident office models, and
browser casting are charged against the same measured appliance capacity.
Unknown or stale memory/storage information blocks a new start with an
actionable error; it is not treated as zero usage.

Per-phone resources and member allowances come from the installed profile and
administrator settings. The UI reports those actual values. A test pool size,
an old fixture's phone count, or an arbitrary media-duration constant must not
be treated as physical appliance capacity. Admission does not silently stop
resident office services or other members' guests.

## Camera settings

Images, videos, the current browser's camera, local USB cameras, and configured
UDP input are sources for the same Android camera interface, not separate ROMs.
The active source is bound to its owner and phone run. Changing a source must
preserve the phone and must clear obsolete frames when the source stops.

The USB catalog lists devices attached to this appliance and authorized for
the member. Selection is explicit; a busy device is not stolen. Capture uses
the selected device handle rather than granting a guest unrestricted host
device access. Browser capture requires browser permission. Upload decoding
checks actual format and available resources, and preserves aspect ratio.

The UDP endpoint uses `PLATFORM_APPLIANCE_LAN_ADDRESS`, or a LAN IP from
`PLATFORM_API_PUBLIC_ORIGIN`. It must identify the same appliance; it is not read
from an enrollment database or supplied as an arbitrary host by the browser.

## Runtime and persistence

The production composition is under `deploy/appliance`; phone runtime and
camera helpers are under `deploy/android/cuttlefish`. The API owns durable
authorization, phone state, and reservations. The Agent controls the exact
local runtime. Camera decoding, Android execution, and storage operations stay
inside their configured service boundaries.

Historical migration files and validation records remain intact. New
single-appliance deployment and recovery acceptance must use the current
configuration and exact runtime; an older successful fixture is not evidence
that a newly changed deployment has been verified.

Member instructions:
`deploy/android/cuttlefish/phone-quickstart.zh-CN.md`.
USB camera instructions:
`deploy/android/cuttlefish/phone-camera-usb.zh-CN.md`.

# User guide

## Sign in and preferences

Open the administrator-provided HTTPS address in a current desktop or mobile
browser and sign in with a local account. The product has no native mobile
application. Use the header controls to switch Simplified Chinese/English and
Light/Dark themes. Report certificate warnings or a plain-HTTP sign-in page;
do not bypass them.

## Workbench applications

The workbench has one unified Assistant conversation for LLM answers and Agent
work. Agent program execution occurs in a per-user Docker sandbox through a
non-invasive OpenCode bridge. Package installation in that sandbox follows the
administrator's pip/npm/APT source policy; it never installs packages on the
host.

Other applications include AI Drawing, Text Recognition (OCR),
Speech Transcription (ASR), Translation, Messaging, Team Drive,
Virtual Phones, Virtual Computers and Wireless Casting. Collaboration, AI applications, and professional tools are all
ApplicationPlugins and may be added or removed by an administrator. AI video
generation is not part of the product scope. All required capabilities run on
this one appliance; no auxiliary box is needed.

## Phones, Windows and casting

- **Virtual Phones** (`/apps/virtual-phones`): create Standard Android or
  Android + Google Play, then open your phone. Each phone has its own data;
  closing the page does not shut it down. Google login takes place inside your
  own Android phone, not in the appliance's platform account. The tested Play
  flow works, but Google certification and universal app compatibility are not
  promised. See [camera inputs](virtual-phone-camera.md) for images, video,
  browser cameras, appliance USB cameras and supported network video.
- **Virtual Computers** (`/apps/virtual-computers`): create and install Windows
  11 ARM64, then use its browser desktop. Windows has its own account and
  licensing requirements. Windows 10 ARM64 is not provided. See the
  [Windows guide](../virtual-computers-user-guide.md).
- **Wireless Casting** (`/apps/wireless-casting`): start a receiver, connect
  from the Apple device using the displayed name and PIN, and watch in the
  browser. You can invite authorized colleagues. There is no HDMI output.
  See [casting instructions](wireless-casting-guide.md).

Use these workbench entries for normal use; localhost development viewers are
not customer entry points. The [delivery summary](../validation/single-appliance-delivery-20261019.md)
lists the accepted scope and remaining handover confirmation.

## Tasks and resources

Batch compute is durably queued. After acceptance, My Tasks shows queued,
running, succeeded, failed, cancelled, or incomplete state, progress, and safe
result artifacts. Retrying the same action with the same idempotency key does
not create duplicate work. Users can cancel their own cancellable tasks.

Realtime ASR/translation/WebRTC sessions connect directly to a healthy local
runtime rather than entering the batch queue. They do not book shared resource
quotas. Actual service, network or allocation failures remain visible. Users choose a
logical model or application, never a physical box, container, GPU, worker, or
external provider.

## Files, messaging, and privacy

Team Drive supports authorized upload, list, download, version selection, and
delete. Large AI inputs enter through encrypted object storage; applications
receive short-lived scoped references, not storage credentials or raw paths.
Messaging is browser based. File and message permissions remain independent
from AI permissions.

Required office tasks run on this appliance. An external OpenAI-compatible
service is an optional, explicitly configured integration, subject to data
policy and permissions; it is not another managed box or a prerequisite for
office use. The interface identifies external processing without exposing
private addresses or secrets. Confidential data is not sent externally unless
the administrator's explicit policy permits it.

## Common problems

- A queued task can be waiting for an exclusive model, service recovery, a worker wake-up, or a model load. Do not resubmit with a new
  idempotency key merely to move ahead.
- “Capability unavailable” means no currently healthy certified route exists;
  it is different from a transient queue wait.
- Missing external GPU metrics are expected when the provider API does not
  expose them; the UI must show “unsupported,” not zero.
- After a session expires, sign in again instead of repeatedly submitting a
  failing mutation.

For persistent errors, copy the correlation/job ID and timestamp—never a
password, recovery code, bearer token, signed URL, file contents, or private
prompt—and give them to the administrator.

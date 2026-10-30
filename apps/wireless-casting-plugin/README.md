# Wireless Casting ApplicationPlugin

First-party, device-free Web workbench for the Team AI Box AirPlay-compatible
casting control plane. It manages session outputs, audience invitations, browser
join/leave, viewers, and redacted health through authenticated platform APIs.

This ApplicationPlugin is deliberately separate from the trusted media service:
it has no host network, device, Docker socket, host filesystem, HDMI-control, or
persistent-media-credential access. Short-lived viewer credentials returned after
an explicit user join gesture remain process-memory-only and are discarded on
leave, stop, navigation, audience revision, or session replacement.

The source workbench does not claim a deployable or Product Accepted receiver.
Real HDMI/audio, Apple sender, WebRTC/SFU, one/eight-viewer, lifecycle, and browser
acceptance remain separate hardware/deployment gates.

When Platform is started with
`PLATFORM_CASTING_AVAILABILITY_FILE=/opt/teamaibox/config/wireless-casting-control-plane.disabled.v1.json`,
the authenticated availability endpoint reports `unsupported`, every receiver
and session-start claim is false, and the workbench hides all session controls in
favor of the exact legal, supply-chain, runtime, security, and hardware gates.
The configuration cannot enable a receiver. A ready successor must replace the
Platform status and activate an admitted trusted-media release in one atomic
cutover.

`tools/deploy_wireless_casting_disabled_control_plane.py --preflight-only`
performs source-only validation. A real deployment run replaces only the Platform
status overlay and retains the previous healthy container for rollback; it never
starts trusted media, LiveKit, a GPU, or a device. The Web image still requires
the ordinary signed ApplicationPlugin packaging and installation workflow.

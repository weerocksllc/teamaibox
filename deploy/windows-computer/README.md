# ARM virtual-computer runtime

`Public.Dockerfile` builds the same ARM TPM physical-presence (PPI) capability
required by the original `windows-arm64-ppi` runtime. It builds QEMU 11.1.1 from
the official release after verifying its detached signature against the pinned
release-manager fingerprint. Debian supplies the container libraries and tools,
not the QEMU executable used to run guests.

Do not replace this executable with an older distribution QEMU package. Windows
profiles enable `tpm-tis-device,...,ppi=on`; a build without that ARM property
exits before firmware starts. Removing `ppi=on`, disabling TPM, or resetting a
guest's TPM is not a compatible repair.

The final image build checks ARM TIS PPI and PulseAudio support and includes the
matching RAM framebuffer ROM. On an ARM KVM host, the bundled
`python3 /usr/local/bin/probe-ppi` performs a diskless, paused QEMU/TPM check.
It does not mount existing guest disks or prove that Windows installation has
completed. Windows boot must be checked separately on an explicitly designated
test guest.

For an existing installation, use the platform's runtime-update policy and the
matching Node Agent profile image digest. Preserve disk, firmware, TPM identity
and state. Do not recreate guests or change running Linux guest images merely to
repair the Windows runtime. Record locally built images as unpublished until
their source changes are committed and released.

Preserve the installed configuration's ownership and read permissions when
updating it. If Platform API is recreated to load the runtime-update policy,
also recreate its network-namespace dependents (`node-agent`,
`appliance-gateway`, `desktop-proxy`, `desktop-gateway`, and
`maintenance-controller`) from their unchanged images. They must join the new
API container's network namespace. This is not a guest, Docker daemon, or AI
worker restart. Wait for the node's normal authenticated heartbeat to restore
readiness before submitting a Windows start operation.

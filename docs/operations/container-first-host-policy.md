# Container-first Spark host policy

The DGX Spark host is an appliance foundation, not an application or build
environment. Product Web servers, frontend toolchains, APIs, databases, queues,
object/messaging/source services, plugins, Agent/OpenCode sandboxes, model
runtimes/workers, and product monitoring run in bounded ARM64 containers.

`deploy/host/release-compatibility.v1.json` records supported foundation
combinations for new installations, not a developer's full inventory. Each
installation records its root-owned `/etc/teamaibox/host-baseline.json`.
Repository allowlists remain historical evidence, not a new-machine gate. The
detector reads architecture, OS/kernel, the Docker/NVIDIA foundation versions,
the count and SHA-256 digest of installed package state, the count and digest of
system service-unit state, Docker service status, and SHA-256/status for a small
fixed set of relevant configuration files. It never emits configuration
contents, machine IDs, MAC addresses, host keys, credentials, or user data.

Run on the appliance without installing Python packages:

```sh
python3 tools/host_drift.py check --allowlist /etc/teamaibox/host-baseline.json --pretty
```

Exit code 0 means the current snapshot conforms. Exit code 2 means release
evidence is blocked. The command uses only read operations and reports
`mutationPerformed: false`; it does not repair drift automatically.

## Exceptions and baseline renewal

A required host/early-boot/kernel/udev integration that cannot reasonably be
containerized needs a time-bounded record based on
`deploy/host/exception.template.json`. It names the owner, exact version,
necessity, security/update impact, rollback, evidence, drift keys, and expiry.
Ordinary product or build convenience is not sufficient.

Security updates and approved DGX/driver/runtime maintenance may legitimately
change the full baseline digest. The baseline is never learned automatically.
Renew it only after the separate host-maintenance workflow records before/after
snapshots, recovery readiness, rollback, and all affected hardware/model
revalidation. Until then the environment is visibly non-conforming and cannot
support a clean-host release claim.

Use `appliance_compatibility.py --record-baseline ... --replace-baseline-digest
<previous SHA-256>` for an explicitly reviewed renewal. It preserves the old
baseline and refuses an unexpected digest or installation identity. See
[portable installation](portable-installation.md). Boot and ordinary checks
never silently refresh the baseline.

# Runtime health and exclusive maintenance

Applications normally share the appliance through the operating system. There
is no platform-wide advance CPU, RAM, codec, display, bandwidth or disk-growth
booking. Guest CPU/RAM/disk settings are actual runtime settings, not reservations
against other guests. Sparse disks use physical space as written; real disk-full
errors must remain visible. Authentication and encrypted per-guest isolation stay.

Explicit exclusive maintenance keeps a durable intent, exact node/job identity
and fencing. It waits for real conflicting operations to stop and probes the
required core services. This is operation serialization, not a resource quota.
Ordinary casting and guest startup cannot demand that another user's guest be
shut down to release an accounting entry.

Health, current memory pressure and actual allocation/OOM errors remain visible.
A missing response never authorizes duplicate creation or erasing guest data.
Migration 117 removes obsolete accounting tables/views without changing guest
records, images, encrypted volumes, firmware, TPM or user accounts. Applied
historical migrations remain immutable; legacy run IDs and wire fields used for
identity compatibility do not perform resource booking.

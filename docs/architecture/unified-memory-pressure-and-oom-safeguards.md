# Unified-memory observation and OOM recovery

DGX Spark exposes unified system memory, not a separate VRAM pool. Observe host
`MemAvailable`, PSI, owned cgroup usage/events, process RSS and engine allocations
without double-counting the same pages. Stale or unavailable telemetry is marked
unknown, never shown as zero usage.

Configured model and guest maxima are not added into a shared reservation ledger.
There is no fixed core-service floor, emergency margin or predicted-growth
admission check. Actual runtime configuration and cgroup safety limits remain.

A real worker OOM or allocation failure is reported for that exact worker/run.
Recovery fences the failed operation, uses bounded retries and may unload idle
non-protected workers. It does not reset guests, erase disks, change identities,
or stop unrelated healthy applications to manufacture an available slot.

Authentication, exact-run fencing, maintenance serialization and encrypted data
isolation are independent of memory observation and remain required.

# Production storage layout

The production appliance has two deliberately different storage domains.
`/var/lib/teamaibox-unlock` is the small pre-unlock domain. It can start only
the HTTPS Unlock Service and contains the allowlisted runtime image, non-secret
volume configuration, unlock TLS identity, a bounded redacted audit buffer,
and—only while Startup Unlock Protection is disabled—the automatic LUKS slot
factor. It never contains team databases, object or model bytes, Agent or
plugin data, source caches, historical audit data, passphrases, USB private
material, or the offline recovery key.

`/srv/teamaibox/data` is the production mount point for the `teamaibox-data`
LUKS2 mapper. `TEAMAIBOX_DATA_ROOT` must resolve to this already-mounted ext4
filesystem before any protected service starts. Compose does not format,
unlock, or mount it. The authoritative machine-readable mapping is
`deploy/storage/appliance-storage-layout.v1.json`; the appliance Compose
overlay binds every persistent volume to an exact directory below that root.

The mapping explicitly covers PostgreSQL and JetStream, encrypted object blobs
and staging, model artifacts/caches/evidence, Agent state/workspaces/cache,
plugin data/cache, audit and protected-secret records, software-source caches,
node identity/state, worker attempt data, and diagnostics.

Docker's image/layer store may remain on the pre-unlock system filesystem
because the Unlock Service container must start while LUKS is closed. No team
data may enter image layers or container writable layers. Node Agent allocates
per-plugin, per-Agent, and per-worker directories as bind mounts below the
protected roots in the layout. Production workloads must not use anonymous or
ordinary Docker named volumes for durable content.

This layout is a contract, not a migration command. Later LUKS tasks operate
only on disposable media until the separately reviewed data-preserving migration,
console recovery, and rollback runbook is complete.

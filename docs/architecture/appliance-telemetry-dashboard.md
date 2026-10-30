# Appliance telemetry and administrator dashboard

The only local execution target is the UUID configured by `PLATFORM_APPLIANCE_NODE_ID`. The local Agent supplies bounded snapshots for CPU, unified memory, accelerator support, disks, codecs, processes, Workers, jobs and reservations. Collection does not discover or connect other devices.

## UI and API

The administrator opens `/admin/device`. `GET /api/v1/admin/appliance` returns the one device's identity and runtime status. Existing operations views may present detailed metrics for that same device, never a selectable device inventory or deployment group.

Each metric distinguishes measured, unsupported, unavailable and stale. Unknown values do not become zero. Derived job, Worker and process values inherit stale status when their source snapshot expires. Spark's unified memory must not be presented as separate dedicated VRAM.

## Safe and useful diagnosis

Keep the latest useful observation, its timestamp and its reason when a source is unavailable. Do not rerun certification or regenerate the application catalog during page requests. Collect aggregate operational facts, not prompts, file contents, credentials or private guest screens.

External API provider health and concurrency are displayed separately. Their private hardware counters remain unsupported unless the API actually provides them. They never enlarge the reported local capacity.


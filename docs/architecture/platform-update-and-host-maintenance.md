# Platform updates and host maintenance

The product has one appliance. Runtime identity is the exact UUID in `PLATFORM_APPLIANCE_NODE_ID`; deployment lives in `deploy/appliance`.

Platform updates replace the affected container images, pages and schema migrations. Host maintenance changes DGX OS, kernel, NVIDIA driver, firmware or container runtime. Page-only releases never restart Android, Windows, model Workers or the API merely for visual changes.

## Plan and apply

Record the exact candidate, current local identity, affected services, compatibility checks and rollback instructions. Host or whole-device maintenance discloses downtime and requires the applicable administrator approval. A plan cannot select another device or rely on spare capacity elsewhere.

Before execution, recheck local resource/storage state and preserve original guest disks and running workload identity. Drain only the affected work according to the approved plan, apply the change, verify the specific postconditions and resume service.

## Recovery

Stop on failure and restore the recorded local release/configuration when safe. Preserve failed evidence and do not automatically reset guests, appliance identity, encryption keys or user accounts. If rollback cannot safely restore service, report the exact recovery action instead of continuing a rollout.

The local Agent may perform bounded host preflight and approved maintenance operations. Plugins and ordinary Agent sandboxes do not receive host command authority. Existing HTTPS and storage protections remain; removing device federation does not require removing those boundaries.

Reuse valid unaffected tests. Driver/runtime changes require tests of affected model/guest components, not an unconditional rerun of every historical qualification.

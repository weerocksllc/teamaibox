import { createHash } from "node:crypto";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY = /^[a-z][a-z0-9-]{1,63}$/;

function fail(code, message, status = 400) { throw new PlatformError(code, message, { status }); }
function exactSet(value, expected) { return Array.isArray(value) && value.length === expected.length && value.every((item, index) => item === expected[index]); }

export class HostMaintenancePolicy {
  #policy;
  constructor({ policy }) {
    const sources = ["dgx-os", "nvidia-compute", "nvidia-container-runtime", "ubuntu-base"];
    const categories = ["dgx-os", "kernel", "nvidia-driver", "firmware", "boot", "docker-runtime", "nvidia-container-toolkit"];
    const evidence = ["before-snapshot", "approved-package-plan", "recovery-or-rollback-plan", "after-snapshot", "host-drift-result", "affected-model-revalidation"];
    if (!policy || policy.schemaVersion !== 1 || policy.policyId !== "official-host-maintenance.v1" || policy.channel !== "host-maintenance"
      || policy.administratorPermission !== "update:manage" || policy.executor !== "node-agent-host-maintenance"
      || policy.sourceConfigurationOwner !== "host-maintenance-service" || policy.separateFromSandboxApt !== true || policy.sandboxWorkloadsAllowed !== false
      || !exactSet(policy.approvedSourceKeys, sources) || !exactSet(policy.allowedCategories, categories) || !exactSet(policy.requiredEvidence, evidence)
      || !exactSet(policy.forbiddenSandboxEndpoints, ["http://source-gateway:8080/apt"])) throw new TypeError("Host maintenance policy is invalid");
    this.#policy = structuredClone(policy);
  }

  authorizePlan({ context, workloadKind, sourceKey, categories, packages, recoveryEvidenceRef }) {
    if (!UUID.test(context?.identityId ?? "")) fail("invalid_session", "Authentication is required", 401);
    if (context.principalKind !== "administrator" || !context.permissions?.includes(this.#policy.administratorPermission)) fail("host_maintenance_permission_required", "Host maintenance administrator permission is required", 403);
    if (workloadKind !== "host-maintenance" || new Set(["agent-sandbox", "application-plugin", "compute-plugin", "compute-worker"]).has(workloadKind)) fail("host_maintenance_channel_required", "Host packages can only use the host maintenance channel", 403);
    if (!this.#policy.approvedSourceKeys.includes(sourceKey)) fail("host_maintenance_source_denied", "Host maintenance source is not approved", 403);
    if (!Array.isArray(categories) || categories.length < 1 || new Set(categories).size !== categories.length || categories.some((value) => !this.#policy.allowedCategories.includes(value))) fail("host_maintenance_category_denied", "Host maintenance category is not approved", 403);
    if (!Array.isArray(packages) || packages.length < 1 || packages.length > 512 || packages.some((value) => typeof value !== "string" || !/^[a-z0-9][a-z0-9+.-]{0,127}(?:=[A-Za-z0-9:~+._-]{1,128})?$/.test(value))) fail("host_maintenance_package_invalid", "Host maintenance package plan is invalid");
    if (typeof recoveryEvidenceRef !== "string" || !/^evidence:\/\/[A-Za-z0-9._/-]{3,256}$/.test(recoveryEvidenceRef)) fail("host_maintenance_recovery_required", "Host recovery or rollback evidence is required", 409);
    const plan = { schemaVersion: 1, channel: this.#policy.channel, executor: this.#policy.executor, target: "appliance-host", sourceKey,
      categories: [...categories].sort(), packages: [...packages].sort(), recoveryEvidenceRef, requestedBy: context.identityId };
    return Object.freeze({ ...plan, planSha256: `sha256:${createHash("sha256").update(JSON.stringify(plan)).digest("hex")}` });
  }
}

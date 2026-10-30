import { PlatformError } from "../../../packages/observability/src/index.mjs";

const ECOSYSTEMS = new Set(["pip", "npm", "apt"]);
const ENVIRONMENTS = new Set(["agent", "application-build", "model-build"]);
const ARCHITECTURES = new Set(["arm64", "amd64", "all", "source"]);

function required(value, values, field) { if (!values.has(value)) throw new PlatformError("source_policy_context_invalid", `${field} is invalid`, { status: 400 }); return value; }
function optionalKey(value, field) { if (value == null) return null; if (typeof value !== "string" || !/^[a-z][a-z0-9_.-]{2,127}$/.test(value)) throw new PlatformError("source_policy_context_invalid", `${field} is invalid`, { status: 400 }); return value; }
function matches(selector, context) { return (selector.teamKey === null || selector.teamKey === context.teamKey) && (selector.sandboxProfileKey === null || selector.sandboxProfileKey === context.sandboxProfileKey) && (selector.architecture === "all" || selector.architecture === "source" || selector.architecture === context.architecture); }
function specificity(selector, architecture) { return (selector.teamKey === null ? 0 : 4) + (selector.sandboxProfileKey === null ? 0 : 2) + (selector.architecture === architecture ? 1 : 0); }

export class SourcePolicyResolver {
  #repository;
  constructor({ repository }) {
    if (!repository?.listPolicies || !repository?.findSource) throw new TypeError("Source policy resolver requires a Source Center repository");
    this.#repository = repository;
  }
  async resolve(context) {
    const request = {
      ecosystem: required(context?.ecosystem, ECOSYSTEMS, "ecosystem"),
      environment: required(context?.environment, ENVIRONMENTS, "environment"),
      architecture: required(context?.architecture, ARCHITECTURES, "architecture"),
      teamKey: optionalKey(context?.teamKey, "teamKey"),
      sandboxProfileKey: optionalKey(context?.sandboxProfileKey, "sandboxProfileKey"),
    };
    const candidates = (await this.#repository.listPolicies({ ecosystem: request.ecosystem }))
      .filter((policy) => policy.enabled && policy.environment === request.environment && matches(policy.selector, request))
      .sort((left, right) => specificity(right.selector, request.architecture) - specificity(left.selector, request.architecture) || left.policyKey.localeCompare(right.policyKey));
    if (!candidates.length) throw new PlatformError("source_policy_unavailable", "No software source policy matches this workload", { status: 503, details: request });
    const selected = candidates[0], sources = [];
    for (const route of selected.sources) {
      const source = await this.#repository.findSource(route.sourceId);
      if (!source || source.ecosystem !== selected.ecosystem) throw new PlatformError("source_policy_inconsistent", "Source policy references an unavailable source", { status: 503, details: { policyKey: selected.policyKey, sourceId: route.sourceId } });
      sources.push(Object.freeze({ sourceId: route.sourceId, priority: route.priority, source: Object.freeze(structuredClone(source)) }));
    }
    return Object.freeze({ policyId: selected.policyId, policyKey: selected.policyKey, ecosystem: selected.ecosystem, environment: selected.environment, selector: Object.freeze(structuredClone(selected.selector)), offlineMode: selected.offlineMode, sources: Object.freeze(sources), packageRules: Object.freeze(selected.packageRules.map((item) => Object.freeze(structuredClone(item)))) });
  }
}

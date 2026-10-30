import { Activity, AlertTriangle, Bot, CheckCircle2, Copy, Database, FlaskConical, LoaderCircle, LockKeyhole, MemoryStick, Network, Power, RefreshCw, Route, ServerCog, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  getExperimentalValidationPolicy,
  getModelCard,
  getModelRuntimeFacts,
  listModelProfiles,
  setExperimentalValidationRouting,
  type ExperimentalRoutingPolicy,
  type ModelCard,
  type ModelLifecycleState,
  type ModelProfileSummary,
  type ModelRuntimeFacts,
  type RuntimeMetric,
} from "./model-admin-client";

const stateKeys: Record<ModelLifecycleState, string> = {
  experimental: "admin.models.state.experimental",
  validating: "admin.models.state.validating",
  certified: "admin.models.state.certified",
  deprecated: "admin.models.state.deprecated",
  failed: "admin.models.state.failed",
  revalidation_required: "admin.models.state.revalidation_required",
};

function compactDigest(value: string | null | undefined) {
  if (!value) return "—";
  return value.length > 24 ? `${value.slice(0, 15)}…${value.slice(-7)}` : value;
}

function displayValue(value: unknown) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function metricValue(metric: RuntimeMetric, kind: "memory" | "milliseconds" | "percent", locale: string, t: (key: string) => string) {
  if (metric?.value === null || metric?.value === undefined) return t(`admin.models.metric.${metric?.status ?? "unavailable"}`);
  let value = "";
  if (kind === "memory") value = `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(metric.value / 1024 ** 3)} GiB`;
  if (kind === "milliseconds") value = `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(metric.value)} ms`;
  if (kind === "percent") value = `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(metric.value)}%`;
  return metric.status === "measured" ? value : `${value} · ${t(`admin.models.metric.${metric.status}`)}`;
}

function RuntimeFacts({ runtime, unavailable, locale, t }: { runtime: ModelRuntimeFacts | null; unavailable: boolean; locale: string; t: (key: string) => string }) {
  return (
    <section className="model-runtime-section" data-model-runtime-state={unavailable ? "unavailable" : runtime?.collectionStatus ?? "loading"}>
      <header><div><Activity size={16} /><span><h3>{t("admin.models.runtime_title")}</h3><small>{t("admin.models.runtime_description")}</small></span></div>{runtime && <em className={`model-runtime-status model-runtime-status--${runtime.collectionStatus}`}>{t(`admin.models.runtime.${runtime.collectionStatus}`)}</em>}</header>
      {unavailable ? <div className="model-runtime-empty" role="alert"><AlertTriangle size={15} aria-hidden="true" />{t("admin.models.runtime_unavailable")}</div> : !runtime ? <div className="model-runtime-empty" role="status" aria-live="polite" aria-busy="true"><LoaderCircle className="auth-spinner" size={15} aria-hidden="true" />{t("admin.models.runtime_loading")}</div> : (
        <>
          <div className="model-runtime-summary"><span><ServerCog size={13} /><strong>{t(runtime.deviceAvailable ? "admin.models.runtime.fresh" : "admin.models.runtime.unavailable")}</strong>{t("admin.models.runtime_nodes")}</span><span><Power size={13} /><strong>{runtime.models.length}</strong>{t("admin.models.runtime_placements")}</span><span><Activity size={13} /><strong>{runtime.workers.length}</strong>{t("admin.models.runtime_workers")}</span><span><Network size={13} /><strong>{runtime.externalMappings.filter((item) => item.enabled).length}</strong>{t("admin.models.runtime_external")}</span></div>
          {runtime.models.length === 0 && runtime.workers.length === 0 ? <div className="model-runtime-empty" data-model-runtime-empty="true"><Power size={15} />{t("admin.models.runtime_not_loaded")}</div> : <div className="model-runtime-list">
            {runtime.models.map((item, index) => <article key={`${item.nodeId ?? "unknown"}:${item.workerId ?? index}`}><span className="model-runtime-icon"><MemoryStick size={15} /></span><div><strong>{item.nodeKey ?? item.nodeId ?? t("admin.models.runtime_unknown_node")}</strong><small>{item.workerId ?? t("admin.models.runtime_no_worker")} · {item.state}</small></div><dl><div><dt>{t("admin.models.runtime_memory")}</dt><dd>{metricValue(item.unifiedMemoryBytes, "memory", locale, t)}</dd></div><div><dt>{t("admin.models.runtime_load")}</dt><dd>{metricValue(item.loadMilliseconds, "milliseconds", locale, t)}</dd></div></dl><em>{item.nodeFreshness ? t(`admin.models.runtime.${item.nodeFreshness}`) : "—"}</em></article>)}
            {runtime.workers.filter((worker) => !runtime.models.some((model) => model.workerId === worker.workerId)).map((item) => <article key={item.workerId}><span className="model-runtime-icon"><Activity size={15} /></span><div><strong>{item.workerId}</strong><small>{item.nodeKey ?? item.nodeId ?? t("admin.models.runtime_unknown_node")} · {item.state}</small></div><dl><div><dt>{t("admin.models.runtime_memory")}</dt><dd>{metricValue(item.unifiedMemoryBytes, "memory", locale, t)}</dd></div><div><dt>{t("admin.models.runtime_accelerator")}</dt><dd>{metricValue(item.acceleratorUtilizationPercent, "percent", locale, t)}</dd></div></dl><em>{item.nodeFreshness ? t(`admin.models.runtime.${item.nodeFreshness}`) : "—"}</em></article>)}
          </div>}
          {runtime.externalMappings.length > 0 && <div className="model-runtime-external"><h4>{t("admin.models.external_routes")}</h4>{runtime.externalMappings.map((item) => <article key={`${item.providerId}:${item.operations.join(",")}`}><ShieldCheck size={14} /><span><strong>{item.displayName}</strong><small>{item.providerKey} · {item.operations.join(" · ") || "—"}</small></span><em className={item.enabled ? "is-enabled" : ""}>{t(item.enabled ? "admin.models.route_enabled" : "admin.models.route_disabled")}</em></article>)}</div>}
        </>
      )}
    </section>
  );
}

function ValidationRouting({ profile, lifecycleState, policy, unavailable, canManage, busy, notice, onToggle, t }: { profile: ModelCard["profile"]; lifecycleState: ModelLifecycleState; policy: ExperimentalRoutingPolicy | null; unavailable: boolean; canManage: boolean; busy: boolean; notice: "success" | "error" | null; onToggle: () => void; t: (key: string) => string }) {
  const routeEnabled = Boolean(policy?.experimentalProfileIds.includes(profile.profileId));
  const isExperimental = lifecycleState === "experimental";
  return (
    <section className="model-routing-control" data-model-validation-route={routeEnabled ? "enabled" : isExperimental ? "disabled" : "ineligible"}>
      <header><div><FlaskConical size={16} /><span><h3>{t("admin.models.validation_route_title")}</h3><small>{t("admin.models.validation_route_description")}</small></span></div><code>validation.default</code></header>
      <div className="model-production-lock"><LockKeyhole size={14} /><span><strong>{t("admin.models.production_locked")}</strong><small>{t("admin.models.production_locked_description")}</small></span></div>
      {unavailable ? <div className="model-routing-notice is-error" role="alert">{t("admin.models.validation_route_unavailable")}</div> : isExperimental ? <div className="model-routing-action"><span><strong>{routeEnabled ? t("admin.models.validation_route_enabled") : t("admin.models.validation_route_disabled")}</strong><small>{profile.profileKey}</small></span><button type="button" className={routeEnabled ? "secondary-button" : "primary-button"} disabled={!canManage || busy} onClick={onToggle}>{busy ? <LoaderCircle className="auth-spinner" size={13} /> : routeEnabled ? <Power size={13} /> : <FlaskConical size={13} />}{t(busy ? "admin.models.validation_route_saving" : routeEnabled ? "admin.models.validation_route_disable" : "admin.models.validation_route_enable")}</button></div> : <div className="model-routing-notice">{t("admin.models.validation_route_ineligible")}</div>}
      {!canManage && <small className="model-routing-readonly">{t("admin.read_only")}</small>}
      {notice && <div className={`model-routing-notice ${notice === "error" ? "is-error" : "is-success"}`} role={notice === "error" ? "alert" : "status"}>{t(notice === "error" ? "admin.models.validation_route_failed" : "admin.models.validation_route_saved")}</div>}
    </section>
  );
}

export function ModelAdministrationPanel({ locale, canManage, t }: {
  locale: string;
  canManage: boolean;
  t: (key: string) => string;
}) {
  const [profiles, setProfiles] = useState<ModelProfileSummary[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [card, setCard] = useState<ModelCard | null>(null);
  const [loading, setLoading] = useState(true);
  const [cardLoading, setCardLoading] = useState(false);
  const [error, setError] = useState(false);
  const [cardError, setCardError] = useState(false);
  const [runtime, setRuntime] = useState<ModelRuntimeFacts | null>(null);
  const [runtimeUnavailable, setRuntimeUnavailable] = useState(false);
  const [policy, setPolicy] = useState<ExperimentalRoutingPolicy | null>(null);
  const [policyUnavailable, setPolicyUnavailable] = useState(false);
  const [routingBusy, setRoutingBusy] = useState(false);
  const [routingNotice, setRoutingNotice] = useState<"success" | "error" | null>(null);

  const loadProfiles = async () => {
    setLoading(true);
    setError(false);
    try {
      const data = await listModelProfiles();
      setProfiles(data);
      setSelectedKey((current) => current && data.some((profile) => profile.profileKey === current)
        ? current
        : data[0]?.profileKey ?? null);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadProfiles(); }, []);

  useEffect(() => {
    if (!selectedKey) {
      setCard(null);
      return undefined;
    }
    let active = true;
    setCardLoading(true);
    setCardError(false);
    setRuntime(null);
    setRuntimeUnavailable(false);
    setPolicy(null);
    setPolicyUnavailable(false);
    setRoutingNotice(null);
    const selectedProfile = profiles.find((profile) => profile.profileKey === selectedKey);
    void Promise.allSettled([
      getModelCard(selectedKey),
      selectedProfile ? getModelRuntimeFacts(selectedProfile.profileId) : Promise.reject(new Error("profile unavailable")),
      canManage ? getExperimentalValidationPolicy() : Promise.resolve(null),
    ]).then(([cardResult, runtimeResult, policyResult]) => {
      if (!active) return;
      if (cardResult.status === "fulfilled") setCard(cardResult.value);
      else { setCard(null); setCardError(true); }
      if (runtimeResult.status === "fulfilled") setRuntime(runtimeResult.value);
      else setRuntimeUnavailable(true);
      if (policyResult.status === "fulfilled") setPolicy(policyResult.value);
      else setPolicyUnavailable(true);
    }).finally(() => { if (active) setCardLoading(false); });
    return () => { active = false; };
  }, [selectedKey, profiles, canManage]);

  const selected = useMemo(
    () => profiles.find((profile) => profile.profileKey === selectedKey) ?? null,
    [profiles, selectedKey],
  );

  const toggleValidationRouting = async () => {
    if (!card || !policy || !canManage) return;
    setRoutingBusy(true);
    setRoutingNotice(null);
    try {
      const enabled = policy.experimentalProfileIds.includes(card.profile.profileId);
      await setExperimentalValidationRouting({ profileId: card.profile.profileId, enabled: !enabled });
      setPolicy(await getExperimentalValidationPolicy());
      setRoutingNotice("success");
    } catch {
      setRoutingNotice("error");
    } finally {
      setRoutingBusy(false);
    }
  };

  if (loading) return <div className="model-admin-state" role="status" aria-live="polite" aria-busy="true"><LoaderCircle className="auth-spinner" size={24} aria-hidden="true" /><span>{t("admin.models.loading")}</span></div>;
  if (error && profiles.length === 0) return (
    <div className="model-admin-state model-admin-state--error" role="alert">
      <AlertTriangle size={24} aria-hidden="true" /><span>{t("admin.models.unavailable")}</span>
      <button type="button" className="secondary-button" onClick={() => void loadProfiles()}><RefreshCw size={14} />{t("admin.models.retry")}</button>
    </div>
  );
  if (profiles.length === 0) return <div className="model-admin-state"><Bot size={25} /><span>{t("admin.models.empty")}</span></div>;

  return (
    <section className="model-admin-workspace" aria-label={t("admin.models.card_title")}>
      <aside className="model-profile-list" aria-label={t("admin.models.profile_list")}>
        <div className="model-panel-heading"><div><strong>{t("admin.models.profile_list")}</strong><small>{profiles.length}</small></div><button type="button" onClick={() => void loadProfiles()} aria-label={t("admin.models.refresh")}><RefreshCw size={14} /></button></div>
        {profiles.map((profile) => (
          <button key={profile.profileId} type="button" className={profile.profileKey === selectedKey ? "is-selected" : ""} aria-pressed={profile.profileKey === selectedKey} onClick={() => setSelectedKey(profile.profileKey)}>
            <span className={`model-state-dot model-state-dot--${profile.state}`} />
            <span><strong>{profile.profileKey}</strong><small>{t(stateKeys[profile.state])}</small></span>
          </button>
        ))}
      </aside>

      <div className="model-card-panel">
        {cardLoading ? <div className="model-admin-state" role="status" aria-live="polite" aria-busy="true"><LoaderCircle className="auth-spinner" size={22} aria-hidden="true" /><span>{t("admin.models.card_loading")}</span></div> : card ? (
          <>
            <header className="model-card-header">
              <div><p className="eyebrow">{t("presentation.label_1")}</p><h2>{card.profile.profileKey}</h2><p>{card.profile.sourceModel ?? "—"}</p></div>
              <span className={`model-lifecycle-badge model-lifecycle-badge--${card.lifecycle.state}`}><span />{t(stateKeys[card.lifecycle.state])}</span>
            </header>

            <div className="model-card-metrics">
              <article><ServerCog size={17} /><span><small>{t("admin.models.engine")}</small><strong>{card.profile.engine ?? "—"}</strong><em>{card.profile.engineVersion ?? ""}</em></span></article>
              <article><Database size={17} /><span><small>{t("admin.models.precision")}</small><strong>{card.profile.precision}</strong><em>{card.profile.exclusive ? t("admin.models.exclusive") : t("admin.models.shared")}</em></span></article>
              <article><Route size={17} /><span><small>{t("admin.models.production_routing")}</small><strong>{card.routingRecommendation.productionEligible ? t("admin.models.eligible") : t("admin.models.blocked")}</strong><em>{card.routingRecommendation.recommendationKey}</em></span></article>
            </div>

            <div className="model-control-grid">
              <RuntimeFacts runtime={runtime} unavailable={runtimeUnavailable} locale={locale} t={t} />
              <ValidationRouting profile={card.profile} lifecycleState={card.lifecycle.state} policy={policy} unavailable={policyUnavailable} canManage={canManage} busy={routingBusy} notice={routingNotice} onToggle={() => void toggleValidationRouting()} t={t} />
            </div>

            <div className="model-card-grid">
              <section><h3>{t("admin.models.compatibility")}</h3><div className="model-compatibility-table">
                {card.compatibilityMatrix.map((row) => <div key={`${row.section}:${row.requirement}`}><span>{row.section}</span><strong>{row.requirement}</strong><code>{row.value}</code></div>)}
              </div></section>
              <section><h3>{t("admin.models.validation")}</h3><div className="model-validation-list">
                {card.validationRuns.length === 0 ? <p>{t("admin.models.no_runs")}</p> : card.validationRuns.map((run) => (
                  <article key={run.runId}><span><CheckCircle2 size={15} /><strong>{run.state}</strong></span><code>{compactDigest(run.runId)}</code><small>{run.stages.filter((stage) => stage.state === "passed").length}/{run.stages.length} {t("admin.models.stages")}</small></article>
                ))}
              </div></section>
            </div>

            <section className="model-comparison-section"><h3>{t("admin.models.comparisons")}</h3>
              {card.comparisons.length === 0 ? <p>{t("admin.models.no_comparisons")}</p> : <div className="model-comparison-grid">{card.comparisons.map((comparison) => (
                <article key={`${comparison.comparisonKind}:${comparison.referenceProfileKey}`}><div><strong>{comparison.comparisonKind}</strong><span>{comparison.outcome}</span></div><p>{comparison.candidateProfileKey} ↔ {comparison.referenceProfileKey}</p><dl>{Object.entries(comparison.performance ?? {}).slice(0, 3).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{displayValue(value)}</dd></div>)}</dl>{comparison.claimBoundary && <small>{comparison.claimBoundary}</small>}</article>
              ))}</div>}
            </section>

            <div className="model-card-grid model-card-grid--bottom">
              <section><h3>{t("admin.models.limitations")}</h3><ul>{card.knownLimitations.length ? card.knownLimitations.map((item) => <li key={item}>{item}</li>) : <li>{t("admin.models.no_limitations")}</li>}</ul></section>
              <details className="precision-details"><summary>{t("admin.models.raw_evidence")}</summary><div className="model-evidence-list">{card.rawRunLinks.length ? card.rawRunLinks.map((link) => <button key={link} type="button" onClick={() => void navigator.clipboard?.writeText(link)}><code>{link}</code><Copy size={13} /></button>) : <p>{t("admin.models.no_evidence")}</p>}</div></details>
            </div>

            <footer className="model-card-footer"><span>{t("admin.models.fingerprint")}: <code>{compactDigest(card.profile.fingerprint)}</code></span><span>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(card.generatedAt))}</span></footer>
          </>
        ) : selected && cardError ? <div className="model-admin-state model-admin-state--error" role="alert"><AlertTriangle size={24} aria-hidden="true" /><span>{t("admin.models.card_unavailable")}</span></div> : null}
      </div>
    </section>
  );
}

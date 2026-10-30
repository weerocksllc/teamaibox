import { AlertTriangle, CheckCircle2, Clock3, HardDriveDownload, RefreshCw, RotateCcw, ServerCog, ShieldCheck, Wrench } from "lucide-react";
import { useEffect, useState } from "react";

import { executeMaintenancePlan, loadMaintenanceAdministration, prepareMaintenancePlan, type MaintenanceAdministration, type MaintenanceCandidate, type MaintenancePlan } from "./maintenance-client";

type Translate = (key: string, values?: Record<string, string | number>) => string;
function compact(value: string) { return value.length > 22 ? `${value.slice(0, 11)}…${value.slice(-8)}` : value; }
const candidateKeys: Readonly<Record<string, string>> = Object.freeze({
  "platform.2026-08-21": "maintenance.candidate.platform_2026_08_21",
  "platform.2026-08-22-health-failure": "maintenance.candidate.platform_2026_08_22_failure",
  "host.2026-08-preflight-only": "maintenance.candidate.host_2026_08_preflight",
});
const instructionKeys: Readonly<Record<string, string>> = Object.freeze({
  "Restore the exact previous release slot recorded before cutover.": "maintenance.instruction.restore_exact_previous_slot",
  "Check device health before resuming services.": "maintenance.instruction.verify_before_resume",
  "Keep the affected node drained and inspect the exact maintenance plan evidence.": "maintenance.instruction.keep_affected_node_drained",
  "Restore the prior digest-bound platform slot before re-enabling routing.": "maintenance.instruction.restore_digest_bound_slot",
  "Reject the unhealthy candidate and atomically restore the prior slot.": "maintenance.instruction.reject_unhealthy_candidate",
  "Verify the restored release digest before resuming service.": "maintenance.instruction.verify_restored_digest",
  "Keep the node drained if automatic rollback cannot restore the previous slot.": "maintenance.instruction.keep_node_drained_after_rollback_failure",
  "Use the previous release digest from the durable plan for manual recovery.": "maintenance.instruction.use_durable_previous_digest",
  "Restore the reviewed DGX OS, driver, runtime, and firmware baseline.": "maintenance.instruction.restore_reviewed_dgx_baseline",
  "Re-run model profile validation before returning the node to production.": "maintenance.instruction.revalidate_models_before_production",
  "Use the separately reviewed DGX host recovery procedure and local console path.": "maintenance.instruction.use_reviewed_host_recovery",
  "Do not invoke sandbox APT or modify the host from the platform container.": "maintenance.instruction.no_sandbox_host_mutation",
});
const findingKeys: Readonly<Record<string, string>> = Object.freeze({
  managed_workloads_require_drain: "maintenance.finding.managed_workloads_require_drain",
  secure_boot_state_unobservable: "maintenance.finding.secure_boot_state_unobservable",
  docker_api_incompatible: "maintenance.finding.docker_api_incompatible",
  preflight_failed: "maintenance.finding.preflight_failed",
  runtime_incompatible: "maintenance.finding.runtime_incompatible",
});
function candidateName(candidate: MaintenanceCandidate, t: Translate) { return t(candidateKeys[candidate.candidateKey] ?? candidate.displayName); }
function instruction(value: string, t: Translate) { return t(instructionKeys[value] ?? value); }
function finding(value: string, t: Translate) { return t(findingKeys[value] ?? value.replaceAll("_", " ")); }
function StateBadge({ state, t }: { state: MaintenancePlan["state"]; t: Translate }) { const Icon = state === "completed" ? CheckCircle2 : state === "blocked" || state === "manual_recovery_required" ? AlertTriangle : Clock3; return <span className={`maintenance-state maintenance-state--${state}`}><Icon size={13} aria-hidden="true" />{t(`maintenance.state.${state}`)}</span>; }

function PlanCard({ plan, selected, onSelect, t }: { plan: MaintenancePlan; selected: boolean; onSelect: () => void; t: Translate }) {
  return <button type="button" className={`maintenance-plan-card ${selected ? "maintenance-plan-card--selected" : ""}`} onClick={onSelect}>
    <span className={`maintenance-plan-icon maintenance-plan-icon--${plan.kind}`}>{plan.kind === "host" ? <Wrench size={18} /> : <ServerCog size={18} />}</span>
    <span><strong>{candidateName(plan.candidate, t)}</strong><small>{plan.candidate.version}</small></span><StateBadge state={plan.state} t={t} />
  </button>;
}

function PlanDetail({ plan, canManage, busy, onExecute, t }: { plan: MaintenancePlan; canManage: boolean; busy: boolean; onExecute: (confirmation: string) => void; t: Translate }) {
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => setConfirmation(""), [plan.planId, plan.revision]);
  const exact = `APPLY ${plan.planId}`, ready = plan.state === "ready";
  return <section className="maintenance-detail" aria-labelledby="maintenance-detail-title">
    <header><div><p className="eyebrow">{t(plan.kind === "host" ? "maintenance.kind.host" : "maintenance.kind.platform")}</p><h3 id="maintenance-detail-title">{candidateName(plan.candidate, t)}</h3><p>{t("maintenance.detail.subtitle")}</p></div><StateBadge state={plan.state} t={t} /></header>
    <div className="maintenance-evidence-grid">
      <article className={plan.preflight.runtimeCompatible ? "is-passed" : "is-blocked"}><ServerCog size={17} /><span>{t("maintenance.evidence.runtime")}</span><strong>{t(plan.preflight.runtimeCompatible ? "maintenance.evidence.compatible" : "maintenance.evidence.incompatible")}</strong><small title={plan.preflight.evidenceDigest}>{compact(plan.preflight.evidenceDigest)}</small></article>
      <article className={plan.kind !== "host" || plan.preflight.secureBootCompatible ? "is-passed" : "is-blocked"}><ShieldCheck size={17} /><span>{t("maintenance.evidence.secure_boot")}</span><strong>{t(plan.kind !== "host" ? "maintenance.evidence.not_applicable" : plan.preflight.secureBootCompatible ? "maintenance.evidence.compatible" : "maintenance.evidence.incompatible")}</strong><small>{t("maintenance.evidence.preflight")}</small></article>
      <article className={plan.compatibility.incompatibleProfileIds.length === 0 ? "is-passed" : "is-blocked"}><RotateCcw size={17} /><span>{t("maintenance.evidence.models")}</span><strong>{t(plan.compatibility.incompatibleProfileIds.length ? "maintenance.evidence.incompatible" : "maintenance.evidence.compatible")}</strong><small>{t("maintenance.evidence.revalidation", { count: plan.compatibility.requiresRevalidationProfileIds.length })}</small></article>
    </div>
    {(plan.blockers.length > 0 || plan.warnings.length > 0) && <div className="maintenance-findings" role={plan.blockers.length > 0 ? "alert" : "status"} aria-live={plan.blockers.length > 0 ? "assertive" : "polite"}>{plan.blockers.map((item) => <span className="is-blocker" key={item}><AlertTriangle size={13} aria-hidden="true" />{finding(item, t)}</span>)}{plan.warnings.map((item) => <span key={item}>{finding(item, t)}</span>)}</div>}
    <div className="maintenance-instructions"><article><strong>{t("maintenance.rollback.title")}</strong>{plan.rollbackInstructions.map((item) => <p key={item}>{instruction(item, t)}</p>)}</article><article><strong>{t("maintenance.recovery.title")}</strong>{plan.recoveryInstructions.map((item) => <p key={item}>{instruction(item, t)}</p>)}</article></div>
    {ready && <div className="maintenance-execute" role="note"><div><AlertTriangle size={18} aria-hidden="true" /><span><strong>{t("maintenance.execute.title")}</strong><small>{t("maintenance.execute.subtitle")}</small></span></div><label><span>{t("maintenance.execute.confirm")}</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={exact} autoComplete="off" /></label><button type="button" className="danger-button" disabled={!canManage || busy || confirmation !== exact} onClick={() => onExecute(confirmation)}>{busy ? t("maintenance.execute.running") : t("maintenance.execute.start")}</button></div>}
    {plan.state === "manual_recovery_required" && <div className="maintenance-manual" role="alert"><AlertTriangle size={18} aria-hidden="true" /><div><strong>{t("maintenance.manual.title")}</strong><small>{t("maintenance.manual.subtitle")}</small></div></div>}
  </section>;
}

export function MaintenancePanel({ canManage, t }: { canManage: boolean; t: Translate }) {
  const [data, setData] = useState<MaintenanceAdministration | null>(null), [state, setState] = useState<"loading" | "ready" | "error">("loading"), [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const [candidateKey, setCandidateKey] = useState(""), [downtimeAcknowledged, setDowntimeAcknowledged] = useState(false), [revalidate, setRevalidate] = useState(true), [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const refresh = async () => { try { const value = await loadMaintenanceAdministration(); setData(value); setState("ready"); setCandidateKey((current) => current || value.candidates[0]?.candidateKey || ""); setSelectedPlanId((current) => current ?? value.plans[0]?.planId ?? null); } catch { setState("error"); } };
  useEffect(() => { void refresh(); }, []);
  const candidate = data?.candidates.find((item) => item.candidateKey === candidateKey), selectedPlan = data?.plans.find((item) => item.planId === selectedPlanId) ?? data?.plans[0] ?? null;
  const device = data?.nodes.length === 1 ? data.nodes[0] : null;
  const deviceReady = device?.lifecycleState === "ready" && device.healthState === "healthy";
  const prepare = async () => { if (!candidate || !device || !deviceReady || busy) return; setBusy(true); setNotice(null); try { const plan = await prepareMaintenancePlan({ kind: candidate.kind, candidateKey, deviceId: device.nodeId, downtimeAcknowledged, revalidationDecision: revalidate ? "fence_and_revalidate" : null }); await refresh(); setSelectedPlanId(plan.planId); setNotice(t(plan.state === "ready" ? "maintenance.prepared" : "maintenance.blocked")); } catch { setNotice(t("maintenance.action_failed")); } finally { setBusy(false); } };
  const execute = async (confirmation: string) => { if (!selectedPlan || busy) return; setBusy(true); setNotice(null); try { await executeMaintenancePlan(selectedPlan.planId, selectedPlan.revision, confirmation); await refresh(); setNotice(t("maintenance.completed")); } catch { await refresh(); setNotice(t("maintenance.action_failed")); } finally { setBusy(false); } };
  const canPrepare = canManage && Boolean(candidate) && deviceReady && downtimeAcknowledged;
  return <section className="maintenance-panel" aria-labelledby="maintenance-title"><header className="maintenance-panel__header"><div><p className="eyebrow">{t("maintenance.eyebrow")}</p><h2 id="maintenance-title">{t("maintenance.title")}</h2><p>{t("maintenance.subtitle")}</p></div><button type="button" className="secondary-button" onClick={() => void refresh()}><RefreshCw size={15} />{t("maintenance.refresh")}</button></header>
    {state === "loading" ? <div className="maintenance-empty" role="status" aria-live="polite" aria-busy="true"><Clock3 size={18} aria-hidden="true" />{t("maintenance.loading")}</div> : state === "error" ? <div className="maintenance-empty is-error" role="alert"><AlertTriangle size={18} aria-hidden="true" />{t("maintenance.error")}</div> : data && <>
      <section className="maintenance-builder"><header><div><strong>{t("maintenance.builder.title")}</strong><small>{t("maintenance.builder.subtitle")}</small></div><span>{canManage ? t("maintenance.manage") : t("maintenance.read_only")}</span></header>
        <div className="maintenance-builder-grid"><label><span>{t("maintenance.candidate")}</span><select value={candidateKey} onChange={(event) => setCandidateKey(event.target.value)}>{data.candidates.map((item) => <option key={item.candidateKey} value={item.candidateKey}>{candidateName(item, t)} · {t(`maintenance.kind.${item.kind}`)}</option>)}</select></label></div>
        <div className="maintenance-decisions"><label><input type="checkbox" checked={revalidate} onChange={(event) => setRevalidate(event.target.checked)} /><span><strong>{t("maintenance.revalidate.title")}</strong><small>{t("maintenance.revalidate.subtitle")}</small></span></label>{<label className="is-warning"><input type="checkbox" checked={downtimeAcknowledged} onChange={(event) => setDowntimeAcknowledged(event.target.checked)} /><span><strong>{t("maintenance.downtime.title")}</strong><small>{t("maintenance.downtime.subtitle")}</small></span></label>}</div>
        <button type="button" className="primary-button" disabled={!canPrepare || busy} onClick={() => void prepare()}><ShieldCheck size={15} />{busy ? t("maintenance.preparing") : t("maintenance.prepare")}</button>
      </section>
      {notice && <p className="maintenance-notice" role="status">{notice}</p>}
      <div className="maintenance-workspace"><aside><header><strong>{t("maintenance.history")}</strong><small>{t("maintenance.history_count", { count: data.plans.length })}</small></header>{data.plans.length ? data.plans.map((plan) => <PlanCard key={plan.planId} plan={plan} selected={selectedPlan?.planId === plan.planId} onSelect={() => setSelectedPlanId(plan.planId)} t={t} />) : <div className="maintenance-empty"><Clock3 size={16} />{t("maintenance.history_empty")}</div>}</aside>{selectedPlan ? <PlanDetail plan={selectedPlan} canManage={canManage} busy={busy} onExecute={(value) => void execute(value)} t={t} /> : <div className="maintenance-empty"><ServerCog size={18} />{t("maintenance.detail.empty")}</div>}</div>
    </>}
  </section>;
}

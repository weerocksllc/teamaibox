import { AlertTriangle, Ban, CheckCircle2, Clock3, Gauge, ListTodo, RadioTower, RefreshCw, Save, ShieldCheck, TimerReset, UsersRound, Workflow } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { containModalFocus } from "../modal-focus";
import { editableKeys, policyInput, preservePolicyBaseline } from "./queue-policy-draft";

import { cancelQueueJob, loadQueueAdministration, updateQueuePolicy,
  type QueueAdministration, type QueueJob, type QueuePolicyInput } from "./queue-administration-client";

type Translate = (key: string, values?: Record<string, string | number>) => string;
function compact(value: string) { return `${value.slice(0, 8)}…${value.slice(-6)}`; }
function timestamp(value: string | null, locale: string) { return value ? new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(new Date(value)) : "—"; }

function JobRow({ job, locale, canManage, busy, onCancel, t }: { job: QueueJob; locale: string; canManage: boolean; busy: boolean; onCancel: () => void; t: Translate }) {
  return <tr data-job-id={job.jobId}>
    <td><code title={job.jobId}>{compact(job.jobId)}</code><small>{timestamp(job.createdAt, locale)}</small></td>
    <td><strong>{job.capabilityKey}</strong><small>{job.operation}</small></td>
    <td><span className={`queue-state queue-state--${job.status}`}>{t(`admin.queues.state.${job.status}`)}</span>{job.waitingReason && <small>{job.waitingReason}</small>}</td>
    <td><strong>{job.priority}</strong><small>{job.route}</small></td>
    <td><strong>{job.attemptCount}</strong><small>{job.currentAttemptStatus ?? "—"}</small></td>
    <td><button type="button" className="queue-cancel" disabled={!canManage || !job.canCancel || busy} onClick={onCancel}><Ban size={12} aria-hidden="true" />{t(job.cancellationRequested ? "admin.queues.cancel_requested" : "admin.queues.cancel")}</button></td>
  </tr>;
}

export function QueueAdministrationPanel({ locale, canManage, t }: { locale: string; canManage: boolean; t: Translate }) {
  const [data, setData] = useState<QueueAdministration | null>(null), [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [draft, setDraft] = useState<QueuePolicyInput | null>(null), [busy, setBusy] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [cancelJob, setCancelJob] = useState<QueueJob | null>(null), [confirmation, setConfirmation] = useState("");
  const dirtyRef = useRef(false), refreshing = useRef(false), cancelPanel = useRef<HTMLElement>(null);
  const latestPolicy = useRef<QueueAdministration["policy"] | null>(null);
  const refresh = async (quiet = false, resetPolicy = false) => {
    if (refreshing.current) return;
    refreshing.current = true;
    if (!quiet) setState("loading");
    try {
      const value = await loadQueueAdministration();
      latestPolicy.current = value.policy;
      if (dirtyRef.current && !resetPolicy) {
        // Keep both the draft AND its original revision so a concurrent
        // administrator's changes still produce a conflict rather than loss.
        setData(current => preservePolicyBaseline(value, current, true));
      } else { setData(value); setDraft(policyInput(value.policy)); }
      setState("ready");
    } catch { setState("error"); }
    finally { refreshing.current = false; }
  };
  useEffect(() => { void refresh(); }, []);
  const dirty = useMemo(() => Boolean(data && draft && editableKeys.some((key) => draft[key] !== data.policy[key])), [data, draft]);
  dirtyRef.current = dirty;
  useEffect(() => cancelJob && cancelPanel.current ? containModalFocus(cancelPanel.current) : undefined, [cancelJob]);
  const setNumber = (key: keyof QueuePolicyInput, value: string) => setDraft((current) => current ? { ...current, [key]: Number(value) } : current);
  const discard = () => { const policy = latestPolicy.current; if (!policy) return; setData(current => current ? { ...current, policy } : current); setDraft(policyInput(policy)); setNotice(null); };
  const save = async () => { if (!data || !draft || busy || refreshing.current) return; setBusy("policy"); setNotice(null); try { await updateQueuePolicy(data.policy.revision, draft); setNotice(t("admin.queues.saved")); await refresh(true, true); } catch { setNotice(t("admin.queues.action_failed")); } finally { setBusy(null); } };
  const cancel = async () => { if (!cancelJob || confirmation !== `CANCEL ${cancelJob.jobId}` || busy) return; setBusy(`cancel:${cancelJob.jobId}`); setNotice(null); try { await cancelQueueJob(cancelJob.jobId); setNotice(t("admin.queues.cancelled")); setCancelJob(null); setConfirmation(""); await refresh(true); } catch { setNotice(t("admin.queues.action_failed")); } finally { setBusy(null); } };
  return <section className="queue-admin" aria-labelledby="queue-admin-title">
    <header className="queue-admin__header"><div><p className="eyebrow">{t("presentation.label_4")}</p><h2 id="queue-admin-title">{t("admin.queues.workspace")}</h2><p>{t("admin.queues.workspace_description")}</p></div><button type="button" className="secondary-button" disabled={state === "loading" || busy !== null} onClick={() => void refresh()}><RefreshCw size={14} aria-hidden="true" />{t("admin.queues.refresh")}</button></header>
    {state === "loading" && <div className="queue-admin-state" role="status" aria-live="polite" aria-busy="true"><Clock3 size={19} aria-hidden="true" />{t("admin.queues.loading")}</div>}
    {state === "error" && <div className="queue-admin-state queue-admin-state--error" role="alert"><AlertTriangle size={19} aria-hidden="true" />{t("admin.queues.unavailable")}</div>}
    {data && draft && <>
      <div className="queue-summary">
        <article><ListTodo size={18} aria-hidden="true" /><span><small>{t("admin.queues.total_jobs")}</small><strong>{data.summary.totalJobs}</strong><em>{t("admin.queues.active_count", { count: data.summary.activeJobs })}</em></span></article>
        <article><Workflow size={18} aria-hidden="true" /><span><small>{t("admin.queues.active_leases")}</small><strong>{data.summary.activeLeases}</strong><em>{t("admin.queues.durable")}</em></span></article>
        <article><RadioTower size={18} aria-hidden="true" /><span><small>{t("admin.queues.realtime")}</small><strong>{data.summary.realtimeReservations}</strong><em>{t("admin.queues.latency_protected")}</em></span></article>
        <article><ShieldCheck size={18} aria-hidden="true" /><span><small>{t("admin.queues.exclusive")}</small><strong>{data.summary.exclusiveIntents}</strong><em>{t("admin.queues.node_fenced")}</em></span></article>
      </div>
      {notice && <p className="queue-notice" role="status">{notice}</p>}
      <div className="queue-admin-grid">
        <form className="queue-policy" onSubmit={(event) => { event.preventDefault(); void save(); }}><header><div><h3>{t("admin.queues.policy")}</h3><p>{t("admin.queues.policy_description")}</p></div><span>REV {data.policy.revision}</span></header>
          <div className="queue-policy-fields">{editableKeys.map((key) => <label key={key}><span>{t(`admin.queues.policy.${key}`)}</span><input type="number" value={draft[key]} min={key === "minimumPriority" || key === "maximumPriority" ? 0 : 1} max={key === "minimumPriority" || key === "maximumPriority" ? 100 : undefined} disabled={!canManage || busy !== null} onChange={(event) => setNumber(key, event.target.value)} /></label>)}</div>
          {dirty && <p role="status">{t("admin.queues.unsaved")}</p>}
          <footer><small>{t("admin.queues.policy_updated", { value: timestamp(data.policy.updatedAt, locale) })}</small>{dirty && <button type="button" className="secondary-button" disabled={busy !== null || state === "loading"} onClick={discard}>{t("admin.queues.discard")}</button>}<button className="primary-button" type="submit" disabled={!canManage || !dirty || busy !== null || state === "loading"}><Save size={13} aria-hidden="true" />{t(busy === "policy" ? "admin.queues.saving" : canManage ? "admin.queues.save" : "admin.read_only")}</button></footer>
        </form>
        <section className="queue-distribution"><header><div><h3>{t("admin.queues.distribution")}</h3><p>{t("admin.queues.distribution_description")}</p></div><Gauge size={18} aria-hidden="true" /></header>
          <div className="queue-status-list">{data.statusCounts.map((item) => <div key={item.status}><span><i className={`queue-dot queue-dot--${item.status}`} />{t(`admin.queues.state.${item.status}`)}</span><strong>{item.count}</strong></div>)}</div>
          <div className="queue-priority-bands">{data.priorityBands.map((item) => <article key={item.band}><small>{t(`admin.queues.priority.${item.band}`)}</small><strong>{item.count}</strong></article>)}</div>
          <div className="queue-oldest"><TimerReset size={14} aria-hidden="true" /><span><small>{t("admin.queues.oldest")}</small><strong>{timestamp(data.summary.oldestQueuedAt, locale)}</strong></span></div>
        </section>
      </div>
      <section className="queue-jobs"><header><div><h3>{t("admin.queues.jobs")}</h3><p>{t("admin.queues.jobs_description")}</p></div><span>{data.jobs.length}</span></header>
        {data.jobs.length === 0 ? <div className="queue-admin-state"><CheckCircle2 size={18} aria-hidden="true" />{t("admin.queues.empty")}</div> : <div className="queue-table-wrap"><table><thead><tr>{["identity", "capability", "state", "priority", "attempts", "action"].map((key) => <th key={key}>{t(`admin.queues.column.${key}`)}</th>)}</tr></thead><tbody>{data.jobs.map((job) => <JobRow key={job.jobId} job={job} locale={locale} canManage={canManage} busy={busy !== null} onCancel={() => { setCancelJob(job); setConfirmation(""); }} t={t} />)}</tbody></table></div>}
      </section>
      <div className="queue-reservation-grid"><section><header><RadioTower size={16} aria-hidden="true" /><div><h3>{t("admin.queues.realtime_reservations")}</h3><p>{t("admin.queues.realtime_description")}</p></div></header>{data.realtimeReservations.length ? <ul>{data.realtimeReservations.map((item) => <li key={item.reservationId}><span><strong>{item.capabilityKey}</strong><small>{compact(item.reservationId)} · {item.route}</small></span><b>{item.schedulerPriority}</b><em>{item.latencyBudgetMilliseconds} ms</em></li>)}</ul> : <p className="queue-empty-small">{t("admin.queues.no_realtime")}</p>}</section>
        <section><header><UsersRound size={16} aria-hidden="true" /><div><h3>{t("admin.queues.exclusive_intents")}</h3><p>{t("admin.queues.exclusive_description")}</p></div></header>{data.exclusiveIntents.length ? <ul>{data.exclusiveIntents.map((item) => <li key={item.intentId}><span><strong>{item.capabilityKey}</strong><small>{compact(item.jobId)} · {compact(item.nodeId)}</small></span><b>{t(`admin.queues.intent.${item.state}`)}</b></li>)}</ul> : <p className="queue-empty-small">{t("admin.queues.no_exclusive")}</p>}</section></div>
    </>}
    {cancelJob && <div className="queue-dialog-backdrop" role="presentation"><section ref={cancelPanel} tabIndex={-1} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); if (!busy) { setCancelJob(null); setConfirmation(""); } } }} className="queue-dialog" role="dialog" aria-modal="true" aria-labelledby="queue-cancel-title"><AlertTriangle size={24} aria-hidden="true" /><h3 id="queue-cancel-title">{t("admin.queues.cancel_title")}</h3><p>{t("admin.queues.cancel_description")}</p><code>{cancelJob.jobId}</code><label><span>{t("admin.queues.confirmation")}</span><input disabled={busy !== null} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={`CANCEL ${cancelJob.jobId}`} autoComplete="off" /></label><footer><button type="button" className="secondary-button" disabled={busy !== null} onClick={() => { setCancelJob(null); setConfirmation(""); }}>{t("app.close")}</button><button type="button" className="danger-button" disabled={confirmation !== `CANCEL ${cancelJob.jobId}` || busy !== null} onClick={() => void cancel()}><Ban size={13} aria-hidden="true" />{t("admin.queues.cancel")}</button></footer></section></div>}
  </section>;
}

import { AlertTriangle, CheckCircle2, Clock3, FileLock2, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";

import { loadAuditEvents, verifyAuditChain, type AuditDomain, type AuditEvent, type AuditVerification } from "./audit-client";

const domains: Array<AuditDomain | "all"> = ["all", "identity", "data", "plugin", "model", "provider", "routing", "agent_confirmation", "source", "security", "key", "backup", "update", "administrator"];
function compact(value: string | null) { return value ? `${value.slice(0, 17)}…${value.slice(-8)}` : "—"; }

export function AuditPanel({ locale, t }: { locale: string; t: (key: string, values?: Record<string, string | number>) => string }) {
  const [domain, setDomain] = useState<AuditDomain | "all">("all");
  const [correlation, setCorrelation] = useState("");
  const [appliedCorrelation, setAppliedCorrelation] = useState<string | null>(null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [verification, setVerification] = useState<AuditVerification | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [verifying, setVerifying] = useState(false);

  const reload = async (selected = domain, selectedCorrelation = appliedCorrelation) => {
    setState("loading");
    try {
      // Opening/filtering a page reads only that page. Full-history verification
      // is an explicit operation below and must never block the event list.
      const page = await loadAuditEvents({ domain: selected === "all" ? null : selected, correlationId: selectedCorrelation });
      setEvents(page.data); setNextCursor(page.nextCursor); setVerification(null); setState("ready");
    } catch { setState("error"); }
  };
  useEffect(() => { void reload(domain, appliedCorrelation); }, [domain, appliedCorrelation]);

  const verify = async () => {
    setVerifying(true);
    try { setVerification(await verifyAuditChain()); } catch { setVerification(null); }
    finally { setVerifying(false); }
  };
  const more = async () => {
    if (!nextCursor) return;
    try { const page = await loadAuditEvents({ domain: domain === "all" ? null : domain, correlationId: appliedCorrelation, cursor: nextCursor }); setEvents((current) => [...current, ...page.data]); setNextCursor(page.nextCursor); } catch { setState("error"); }
  };
  const search = (event: FormEvent) => { event.preventDefault(); const value = correlation.trim() || null; if (value === appliedCorrelation) void reload(domain, value); else setAppliedCorrelation(value); };
  const clearCorrelation = () => { setCorrelation(""); setAppliedCorrelation(null); };

  return (
    <section className="audit-panel" aria-labelledby="audit-panel-title">
      <header className="audit-panel__header">
        <div><p className="eyebrow">{t("audit.eyebrow")}</p><h2 id="audit-panel-title">{t("audit.title")}</h2><p>{t("audit.subtitle")}</p></div>
        <button type="button" className="secondary-button" onClick={() => void reload()}><RefreshCw size={15} aria-hidden="true" />{t("audit.refresh")}</button>
      </header>

      <div className={`audit-integrity ${verification ? verification.valid ? "audit-integrity--valid" : "audit-integrity--invalid" : "audit-integrity--unchecked"}`} role="status">
        <span>{verification?.valid ? <ShieldCheck size={24} aria-hidden="true" /> : verification ? <AlertTriangle size={24} aria-hidden="true" /> : <FileLock2 size={24} aria-hidden="true" />}</span>
        <div><strong>{t(verification?.valid ? "audit.integrity.valid" : verification ? "audit.integrity.invalid" : "audit.integrity.unavailable")}</strong>
          <small>{verification ? t("audit.integrity.summary", { count: verification.verifiedEvents }) : t("audit.integrity.no_report")}</small></div>
        <code title={verification?.headEventHash ?? ""}>{compact(verification?.headEventHash ?? null)}</code>
        <button type="button" className="text-button" disabled={verifying} onClick={() => void verify()}>{verifying ? <Clock3 size={14} aria-hidden="true" /> : <CheckCircle2 size={14} aria-hidden="true" />}{t(verifying ? "audit.verifying" : "audit.verify")}</button>
      </div>

      <div className="audit-toolbar">
        <label><span>{t("audit.domain")}</span><select value={domain} onChange={(event) => setDomain(event.target.value as AuditDomain | "all")}>{domains.map((item) => <option key={item} value={item}>{t(`audit.domain.${item}`)}</option>)}</select></label>
        <form className="audit-correlation" onSubmit={search}><label><span>{t("audit.correlation")}</span><input value={correlation} onChange={(event) => setCorrelation(event.target.value)} minLength={8} maxLength={128} pattern="[A-Za-z0-9][A-Za-z0-9._:-]{7,127}" placeholder="request-…" /></label><button type="submit" disabled={correlation.trim().length > 0 && correlation.trim().length < 8}><Search size={13} aria-hidden="true" />{t("audit.search")}</button>{appliedCorrelation && <button type="button" onClick={clearCorrelation}><X size={13} aria-hidden="true" />{t("audit.clear")}</button>}</form>
        <span><FileLock2 size={15} aria-hidden="true" />{t("audit.append_only")}</span>
      </div>

      {state === "loading" ? <div className="audit-state" role="status" aria-live="polite" aria-busy="true"><Clock3 size={18} aria-hidden="true" />{t("audit.loading")}</div>
        : state === "error" ? <div className="audit-state audit-state--error" role="alert"><AlertTriangle size={18} aria-hidden="true" />{t("audit.error")}</div>
          : events.length === 0 ? <div className="audit-state"><FileLock2 size={18} aria-hidden="true" />{t("audit.empty")}</div>
            : <div className="audit-event-list">{events.map((item) => <details className="audit-event" key={item.eventId}><summary>
              <span className={`audit-event__outcome audit-event__outcome--${item.outcome}`} aria-hidden="true" />
              <div className="audit-event__main"><strong>{item.action}</strong><small>{t(`audit.domain.${item.domain}`)} · {t(`audit.outcome.${item.outcome}`)} · {new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(new Date(item.occurredAt))}</small></div>
              <div className="audit-event__resource"><span>{item.resource.kind}</span><code title={item.resource.id}>{compact(item.resource.id)}</code></div>
              <div className="audit-event__proof"><span>#{item.sequenceId} · {t("audit.correlation_short")}</span><code title={`${item.correlationId}\n${item.eventHash}`}>{compact(item.correlationId)}</code></div>
              </summary><dl className="audit-event__details">
                <div><dt>{t("audit.detail.resource")}</dt><dd>{item.resource.kind} · {item.resource.id}</dd></div>
                <div><dt>{t("audit.correlation")}</dt><dd>{item.correlationId}</dd></div>
                <div><dt>{t("audit.detail.actor")}</dt><dd>{item.actor.kind} · {item.actor.identityId ?? "—"}</dd></div>
                <div><dt>{t("audit.detail.event")}</dt><dd>{item.eventId}</dd></div>
                <div><dt>{t("audit.detail.hash")}</dt><dd>{item.eventHash}</dd></div>
              </dl>
            </details>)}</div>}
      {nextCursor && <button type="button" className="audit-more" onClick={() => void more()}>{t("audit.load_more")}</button>}
    </section>
  );
}

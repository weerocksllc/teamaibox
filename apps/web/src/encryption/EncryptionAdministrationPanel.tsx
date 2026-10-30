import { AlertTriangle, CheckCircle2, CircleOff, KeyRound, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import { commitStartupProtection, loadEncryptionAdministration, prepareStartupProtection,
  type EncryptionAdministration, type EncryptionMode, type EncryptionTransition } from "./encryption-client";

type Translate = (key: string, values?: Record<string, string | number>) => string;
const UUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
function stateIcon(state: string) { return state === "passed" ? <CheckCircle2 size={15} /> : state === "failed" ? <AlertTriangle size={15} /> : <CircleOff size={15} />; }

export function EncryptionAdministrationPanel({ locale, canManage, t }: { locale: string; canManage: boolean; t: Translate }) {
  const [data, setData] = useState<EncryptionAdministration | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [mode, setMode] = useState<Exclude<EncryptionMode, "automatic">>("web_passphrase");
  const [prepared, setPrepared] = useState<EncryptionTransition | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const [prepareConfirmation, setPrepareConfirmation] = useState(""), [commitConfirmation, setCommitConfirmation] = useState("");
  const refresh = async () => { setState("loading"); try { setData(await loadEncryptionAdministration()); setState("ready"); } catch { setState("error"); } };
  useEffect(() => { void refresh(); }, []);
  const prerequisitesPassed = data?.prerequisites.every((item) => item.state === "passed") ?? false;
  const exactPrepare = "PREPARE WEB PASSPHRASE";
  const exactCommit = prepared ? `ENABLE ${prepared.planId}` : "";
  const prepare = async (form: HTMLFormElement) => {
    if (busy) return; const values = new FormData(form); setBusy(true); setNotice(null);
    try {
      const plan = await prepareStartupProtection({ mode, recoveryVerificationId: String(values.get("recoveryVerificationId")),
        selectedVerificationId: String(values.get("selectedVerificationId")), confirmation: prepareConfirmation });
      setPrepared(plan); setPrepareConfirmation(""); setNotice(t("encryption.prepare_succeeded")); await refresh();
    } catch { setNotice(t("encryption.action_failed")); } finally { setBusy(false); }
  };
  const commit = async () => {
    if (!prepared || busy) return; setBusy(true); setNotice(null);
    try { await commitStartupProtection(prepared, commitConfirmation); setPrepared(null); setCommitConfirmation(""); setNotice(t("encryption.enable_succeeded")); await refresh(); }
    catch { setPrepared(null); setCommitConfirmation(""); setNotice(t("encryption.action_failed")); await refresh(); } finally { setBusy(false); }
  };
  return <section className="encryption-panel" aria-labelledby="encryption-panel-title">
    <header className="encryption-panel__header"><div><p className="eyebrow">{t("encryption.eyebrow")}</p><h2 id="encryption-panel-title">{t("encryption.title")}</h2><p>{t("encryption.subtitle")}</p></div><button type="button" className="secondary-button" onClick={() => void refresh()}><RefreshCw size={14} />{t("encryption.refresh")}</button></header>
    {notice && <p className="encryption-notice" role="status">{notice}</p>}
    {state === "loading" ? <div className="encryption-state" role="status" aria-live="polite" aria-busy="true"><LoaderCircle className="auth-spinner" size={18} aria-hidden="true" />{t("encryption.loading")}</div>
      : state === "error" ? <div className="encryption-state encryption-state--error" role="alert"><AlertTriangle size={18} aria-hidden="true" />{t("encryption.error")}</div>
      : data && <>
        <div className="encryption-summary">
          <article><span><LockKeyhole size={16} />{t("encryption.block.title")}</span><strong>{t(`encryption.block.${data.blockEncryption.status}`)}</strong><small>{t("encryption.block.hint")}</small></article>
          <article><span><ShieldCheck size={16} />{t("encryption.startup.title")}</span><strong>{t(data.startupProtection.enabled ? "encryption.startup.enabled" : "encryption.startup.default")}</strong><small>{t(`encryption.mode.${data.startupProtection.mode}`)}</small></article>
          <article><span><KeyRound size={16} />{t("encryption.transition.title")}</span><strong>{t(data.capabilities.transition ? "encryption.transition.ready" : "encryption.transition.unavailable")}</strong><small>{t("encryption.transition.hint")}</small></article>
        </div>
        <div className="encryption-workspace">
          <section className="encryption-readiness"><header><div><strong>{t("encryption.readiness.title")}</strong><small>{t("encryption.readiness.subtitle")}</small></div><span>{data.prerequisites.filter((item) => item.state === "passed").length}/{data.prerequisites.length}</span></header>
            <ul>{data.prerequisites.map((item) => <li key={item.key} className={`encryption-prerequisite encryption-prerequisite--${item.state}`}>{stateIcon(item.state)}<span>{t(`encryption.prerequisite.${item.key}`)}</span><b>{t(`encryption.prerequisite_state.${item.state}`)}</b></li>)}</ul>
          </section>
          <section className="encryption-modes"><header><strong>{t("encryption.modes.title")}</strong><small>{t("encryption.modes.subtitle")}</small></header>
            <button type="button" className={mode === "web_passphrase" ? "encryption-mode encryption-mode--selected" : "encryption-mode"} disabled={!data.capabilities.webPassphrase || data.startupProtection.enabled} onClick={() => { setMode("web_passphrase"); setPrepareConfirmation(""); }}><KeyRound size={19} /><span><strong>{t("encryption.mode.web_passphrase")}</strong><small>{t(data.capabilities.webPassphrase ? "encryption.mode.web_hint" : "encryption.mode.web_unavailable")}</small></span></button>
          </section>
        </div>
        {!data.startupProtection.enabled && <form className="encryption-enable" onSubmit={(event) => { event.preventDefault(); void prepare(event.currentTarget); }}>
          <header><div><strong>{t("encryption.enable.title")}</strong><small>{t("encryption.enable.subtitle")}</small></div><AlertTriangle size={18} /></header>
          <div className="encryption-ticket-grid"><label>{t("encryption.recovery_ticket")}<input name="recoveryVerificationId" pattern={UUID_PATTERN} autoComplete="off" required /></label><label>{t("encryption.selected_ticket")}<input name="selectedVerificationId" pattern={UUID_PATTERN} autoComplete="off" required /></label></div>
          <label>{t("encryption.prepare_confirmation")}<input value={prepareConfirmation} onChange={(event) => setPrepareConfirmation(event.target.value)} placeholder={exactPrepare} autoComplete="off" required /></label>
          <button className="primary-button" disabled={!canManage || busy || !data.capabilities.transition || !prerequisitesPassed || prepareConfirmation !== exactPrepare}><ShieldCheck size={14} />{t(busy ? "encryption.preparing" : "encryption.prepare")}</button>
          {(!data.capabilities.transition || !prerequisitesPassed) && <p className="encryption-blocker"><CircleOff size={14} />{t("encryption.enable_blocked")}</p>}
        </form>}
        {prepared && <section className="encryption-commit"><header><div><p className="eyebrow">{t("encryption.commit.eyebrow")}</p><strong>{t("encryption.commit.title")}</strong><small>{prepared.planId} · {t(`encryption.transition_state.${prepared.state}`)}</small></div><ShieldCheck size={20} aria-hidden="true" /></header><p role="alert">{t("encryption.commit.warning")}</p><label>{t("encryption.commit_confirmation")}<input value={commitConfirmation} onChange={(event) => setCommitConfirmation(event.target.value)} placeholder={exactCommit} autoComplete="off" /></label><button type="button" className="danger-button" disabled={!canManage || busy || commitConfirmation !== exactCommit} onClick={() => void commit()}><LockKeyhole size={14} aria-hidden="true" />{t("encryption.commit")}</button></section>}
        <section className="encryption-history"><header><strong>{t("encryption.history.title")}</strong><small>{t("encryption.history.subtitle")}</small></header>{data.recentTransitions.length === 0 ? <p>{t("encryption.history.empty")}</p> : <div>{data.recentTransitions.map((item) => <article key={item.planId}><span><b>{t(`encryption.mode.${item.mode}`)}</b><small>{item.planId}</small></span><strong>{t(`encryption.transition_state.${item.state}`)}</strong><time dateTime={item.preparedAt}>{new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(item.preparedAt))}</time></article>)}</div>}</section>
      </>}
  </section>;
}

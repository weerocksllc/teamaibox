import { AlertTriangle, Check, CircleUserRound, KeyRound, LoaderCircle, Plus, RefreshCw, ShieldCheck, UserRoundCheck, UserRoundX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EditorDialog } from "../EditorDialog";

import {
  createLocalMember,
  IdentityAdministrationApiError,
  listManagedIdentities,
  resetManagedIdentityPassword,
  setManagedIdentityStatus,
  type ManagedIdentity,
  type IdentityPage,
} from "./identity-administration-client";

type PendingAction = Readonly<{
  kind: "disable" | "enable" | "reset";
  identity: ManagedIdentity;
}>;

export function UserAdministrationPanel({ locale, canManage, actorIdentityId, t }: {
  locale: string;
  canManage: boolean;
  actorIdentityId: string | null;
  t: (key: string, values?: Record<string, string | number>) => string;
}) {
  const [identities, setIdentities] = useState<ManagedIdentity[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [page, setPage] = useState<IdentityPage | null>(null);
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const requestSequence = useRef(0);
  const createButton = useRef<HTMLButtonElement>(null);

  const load = async (offset = page?.offset ?? 0, query = appliedSearch) => {
    const sequence = ++requestSequence.current;
    setState("loading");
    setFailure(null);
    try {
      const result = await listManagedIdentities(offset, query);
      if (sequence !== requestSequence.current) return;
      setPage(result);
      setAppliedSearch(query);
      setIdentities(result.data);
      setState("ready");
    } catch {
      if (sequence === requestSequence.current) setState("error");
    }
  };

  useEffect(() => { void load(0, ""); return () => { requestSequence.current++; }; }, []);
  const ownerCount = page?.summary.owners ?? 0;

  const act = async (operation: () => Promise<unknown>, successKey: string) => {
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      await operation();
      await load();
      setPending(null);
      setComposerOpen(false);
      setNotice(t(successKey));
    } catch (error) {
      const code = error instanceof IdentityAdministrationApiError ? error.code : "request_failed";
      const known = new Set([
        "identity_exists", "identity_not_found", "last_owner", "identity_self_disable_forbidden",
        "password_too_short", "password_too_long", "password_blocklisted", "identity_login_invalid",
        "invalid_display_name", "csrf_unavailable",
      ]);
      setFailure(t(`admin.users.error.${known.has(code) ? code : "request_failed"}`));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="identity-admin" aria-labelledby="identity-admin-title">
      <header className="identity-admin__header">
        <div>
          <p className="eyebrow">{t("presentation.label_6")}</p>
          <h2 id="identity-admin-title">{t("admin.users.workspace")}</h2>
          <p>{t("admin.users.workspace_description")}</p>
        </div>
        <div>
          <button type="button" className="secondary-button" onClick={() => void load()} disabled={busy}>
            <RefreshCw size={14} aria-hidden="true" />{t("admin.users.refresh")}
          </button>
          {canManage && (
            <button ref={createButton} type="button" className="primary-button" aria-expanded={composerOpen} aria-controls="create-member-form" onClick={() => { setComposerOpen((current) => !current); setPending(null); }} disabled={busy}>
              <Plus size={14} aria-hidden="true" />{t("admin.users.create")}
            </button>
          )}
        </div>
      </header>

      {notice && <p className="identity-admin__notice" role="status"><Check size={14} aria-hidden="true" />{notice}</p>}
      {failure && <p className="identity-admin__error" role="alert"><AlertTriangle size={14} aria-hidden="true" />{failure}</p>}

      <div className="identity-admin__summary">
        <article><CircleUserRound size={18} aria-hidden="true" /><span><small>{t("admin.users.total")}</small><strong>{page?.summary.total ?? "—"}</strong></span></article>
        <article><UserRoundCheck size={18} aria-hidden="true" /><span><small>{t("admin.users.active")}</small><strong>{page?.summary.active ?? "—"}</strong></span></article>
        <article><ShieldCheck size={18} aria-hidden="true" /><span><small>{t("admin.users.owners")}</small><strong>{page?.summary.owners ?? "—"}</strong></span></article>
      </div>

      <form className="identity-admin__search" role="search" aria-label={t("admin.users.search")} onSubmit={(event) => { event.preventDefault(); void load(0, search.trim()); }}>
        <label>{t("admin.users.search")}<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} disabled={busy} /></label>
        <button type="submit" className="secondary-button" disabled={busy || state === "loading"}>{t("admin.users.search_action")}</button>
        {(search || appliedSearch) && <button type="button" className="secondary-button" disabled={busy} onClick={() => { setSearch(""); void load(0, ""); }}>{t("admin.users.clear_search")}</button>}
      </form>

      {composerOpen && <EditorDialog title={t("admin.users.create_title")} description={t("admin.users.create_hint")} busy={busy} onCancel={() => setComposerOpen(false)} feedback={failure}><CreateMemberForm busy={busy} t={t} onCancel={() => { setComposerOpen(false); createButton.current?.focus(); }} onSubmit={(input) => void act(() => createLocalMember(input), "admin.users.created")} /></EditorDialog>}

      {pending && (
        <EditorDialog title={t(`admin.users.confirm.${pending.kind}`, { name: pending.identity.displayName })} description={t(`admin.users.confirm.${pending.kind}_hint`)} busy={busy} onCancel={() => setPending(null)} feedback={failure}><ActionConfirmation
          pending={pending}
          busy={busy}
          t={t}
          onCancel={() => setPending(null)}
          onConfirm={(password) => {
            const operation = pending.kind === "reset"
              ? () => resetManagedIdentityPassword(pending.identity.id, password)
              : () => setManagedIdentityStatus(pending.identity.id, pending.kind === "enable" ? "active" : "disabled");
            void act(operation, pending.kind === "reset" ? "admin.users.password_reset" : pending.kind === "enable" ? "admin.users.enabled" : "admin.users.disabled");
          }}
        /></EditorDialog>
      )}

      {state === "loading" ? (
        <div className="identity-admin__state" role="status" aria-live="polite" aria-busy="true"><LoaderCircle className="auth-spinner" size={22} aria-hidden="true" />{t("admin.users.loading")}</div>
      ) : state === "error" ? (
        <div className="identity-admin__state identity-admin__state--error" role="alert"><AlertTriangle size={22} aria-hidden="true" />{t("admin.users.unavailable")}</div>
      ) : identities.length === 0 ? (
        <div className="identity-admin__state" role="status"><CircleUserRound size={22} />{t(appliedSearch ? "admin.users.no_matches" : "admin.users.empty")}</div>
      ) : (
        <div className="identity-admin__table-wrap">
          <table className="identity-admin__table">
            <thead><tr><th>{t("admin.users.account")}</th><th>{t("admin.users.roles")}</th><th>{t("admin.users.status")}</th><th>{t("admin.users.last_sign_in")}</th><th>{t("admin.users.actions")}</th></tr></thead>
            <tbody>{identities.map((identity) => {
              const isActor = identity.id === actorIdentityId;
              const finalOwner = identity.roles.includes("owner") && identity.status === "active" && ownerCount <= 1;
              return (
                <tr key={identity.id} data-identity-login={identity.loginName}>
                  <td><strong>{identity.displayName}</strong><small>@{identity.loginName}{isActor ? ` · ${t("admin.users.you")}` : ""}</small></td>
                  <td><div className="identity-role-list">{identity.roles.map((role) => <span key={role}>{t(`role.${role}`)}</span>)}</div></td>
                  <td><span className={`identity-status identity-status--${identity.status}`}>{identity.status === "active" ? <UserRoundCheck size={13} /> : <UserRoundX size={13} />}{t(`admin.users.status.${identity.status}`)}</span></td>
                  <td><time>{identity.lastAuthenticatedAt ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(identity.lastAuthenticatedAt)) : t("admin.users.never")}</time></td>
                  <td><div className="identity-actions">
                    {canManage && <button type="button" disabled={busy} onClick={() => setPending({ kind: "reset", identity })}><KeyRound size={12} />{t("admin.users.reset_password")}</button>}
                    {canManage && identity.status === "active" && <button type="button" disabled={busy || finalOwner || isActor} title={finalOwner ? t("admin.users.final_owner") : isActor ? t("admin.users.self_disable") : undefined} onClick={() => setPending({ kind: "disable", identity })}><UserRoundX size={12} />{t("admin.users.disable")}</button>}
                    {canManage && identity.status === "disabled" && <button type="button" disabled={busy} onClick={() => setPending({ kind: "enable", identity })}><UserRoundCheck size={12} />{t("admin.users.enable")}</button>}
                  </div></td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      )}
      {state === "ready" && page && <nav className="identity-admin__pagination" aria-label={t("admin.users.pages")}>
        <span role="status">{t("admin.users.range", { start: identities.length ? page.offset + 1 : 0, end: page.offset + identities.length, total: page.summary.matching })}</span>
        <button type="button" className="secondary-button" disabled={busy || page.offset === 0} onClick={() => void load(Math.max(0, page.offset - page.limit))}>{t("admin.users.previous")}</button>
        <button type="button" className="secondary-button" disabled={busy || !page.hasMore} onClick={() => void load(page.offset + page.limit)}>{t("admin.users.next")}</button>
      </nav>}
    </section>
  );
}

function CreateMemberForm({ busy, t, onSubmit, onCancel }: {
  busy: boolean;
  t: (key: string) => string;
  onSubmit: (input: { loginName: string; displayName: string; password: string }) => void;
  onCancel: () => void;
}) {
  return <form id="create-member-form" className="identity-composer" onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onCancel(); } }} onSubmit={(event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onSubmit({ loginName: String(form.get("loginName")), displayName: String(form.get("displayName")), password: String(form.get("password")) });
  }}>

    <label>{t("admin.users.login_name")}<input autoFocus name="loginName" required pattern="[a-z][a-z0-9._-]{2,63}" autoComplete="off" /></label>
    <label>{t("admin.users.display_name")}<input name="displayName" required maxLength={128} autoComplete="off" /></label>
    <label>{t("admin.users.initial_password")}<input name="password" type="password" required minLength={15} maxLength={256} autoComplete="new-password" /></label>
    <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{t("common.cancel")}</button>
    <button type="submit" className="primary-button" disabled={busy}>{busy ? <LoaderCircle className="auth-spinner" size={14} /> : <Plus size={14} />}{t("admin.users.create_member")}</button>
  </form>;
}

function ActionConfirmation({ pending, busy, t, onCancel, onConfirm }: {
  pending: PendingAction;
  busy: boolean;
  t: (key: string, values?: Record<string, string | number>) => string;
  onCancel: () => void;
  onConfirm: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  return <section className="identity-confirmation">
    {pending.kind === "reset" && <label>{t("admin.users.new_password")}<input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={15} maxLength={256} autoComplete="new-password" /></label>}
    <div><button autoFocus={pending.kind !== "reset"} type="button" className="secondary-button" onClick={onCancel} disabled={busy}>{t("common.cancel")}</button><button type="button" className={pending.kind === "disable" ? "danger-button" : "primary-button"} onClick={() => onConfirm(password)} disabled={busy || (pending.kind === "reset" && password.length < 15)}>{busy ? <LoaderCircle className="auth-spinner" size={14} /> : null}{t("common.confirm")}</button></div>
  </section>;
}

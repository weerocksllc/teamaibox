import { AlertTriangle, Check, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck, UsersRound, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { DirectoryControls } from "../users/DirectoryControls";
import { EditorDialog } from "../EditorDialog";

import { loadRoleAdministration, RoleAdministrationApiError, setIdentityRole, type AuthorizationRole, type RoleAdministrationOverview, type RoleIdentity } from "./role-administration-client";

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Pending = Readonly<{ identity: RoleIdentity; role: AuthorizationRole; granted: boolean }>;

const roleOrder = ["owner", "system_admin", "compute_admin", "application_admin", "team_admin", "developer", "member", "guest"];

export function RoleAdministrationPanel({ canManage, actorIdentityId, t }: { canManage: boolean; actorIdentityId: string | null; t: Translate }) {
  const [overview, setOverview] = useState<RoleAdministrationOverview | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [pending, setPending] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef(0), query = useRef("");
  const roles = useMemo(() => [...(overview?.roles ?? [])].sort((left, right) => roleOrder.indexOf(left.roleKey) - roleOrder.indexOf(right.roleKey)), [overview]);
  const refresh = async (offset = overview?.identityPage?.offset ?? 0, search = query.current) => {
    const current = ++request.current; query.current = search;
    setState("loading"); setErrorCode(null);
    try { const value = await loadRoleAdministration(offset, search); if (current !== request.current) return; setOverview(value); setState("ready"); }
    catch (error) { if (current !== request.current) return; setErrorCode(error instanceof RoleAdministrationApiError ? error.code : "role_request_failed"); setState("error"); }
  };
  useEffect(() => { void refresh(); return () => { request.current++; }; }, []);
  const apply = async () => {
    if (!pending) return;
    setSaving(true); setErrorCode(null); setNotice(null);
    try {
      await setIdentityRole({ identityId: pending.identity.id, roleKey: pending.role.roleKey, granted: pending.granted });
      setNotice(t(pending.granted ? "admin.roles.grant_succeeded" : "admin.roles.revoke_succeeded", { name: pending.identity.displayName, role: t(`role.${pending.role.roleKey}`) }));
      setPending(null); await refresh();
    } catch (error) { setErrorCode(error instanceof RoleAdministrationApiError ? error.code : "role_request_failed"); }
    finally { setSaving(false); }
  };
  if (state === "loading" && !overview) return <section className="role-admin role-admin__state" role="status" aria-live="polite" aria-busy="true"><LoaderCircle className="auth-spinner" size={22} aria-hidden="true" /><p>{t("admin.roles.loading")}</p></section>;
  if (state === "error" && !overview) return <section className="role-admin role-admin__state role-admin__state--error" role="alert"><AlertTriangle size={22} aria-hidden="true" /><p>{t(`admin.roles.error.${errorCode}`)}</p><button type="button" onClick={() => void refresh()}><RefreshCw size={13} />{t("common.retry")}</button></section>;
  return <section className="role-admin">
    <header className="role-admin__header"><div><p className="eyebrow">{t("admin.roles.eyebrow")}</p><h2>{t("admin.roles.title")}</h2><p>{t("admin.roles.subtitle")}</p></div><button type="button" disabled={state === "loading"} onClick={() => void refresh()}><RefreshCw size={14} />{t("admin.roles.refresh")}</button></header>
    {notice && <div className="role-admin__notice" role="status" aria-live="polite"><Check size={15} aria-hidden="true" />{notice}</div>}
    {errorCode && <div className="role-admin__error" role="alert"><AlertTriangle size={15} aria-hidden="true" />{t(`admin.roles.error.${errorCode}`)}</div>}
    <div className="role-admin__cards">{roles.map((role) => <article key={role.roleKey} data-role-key={role.roleKey}>
      <header><span><ShieldCheck size={18} /></span><div><strong>{t(`role.${role.roleKey}`)}</strong><small>{t(`role.${role.roleKey}.description`)}</small></div><em>{role.bindingCount}</em></header>
      <div className="role-admin__facts"><span><UsersRound size={12} />{t("admin.roles.bindings", { count: role.bindingCount })}</span><span><LockKeyhole size={12} />{t("admin.roles.permissions", { count: role.permissions.length })}</span></div>
      <details><summary>{t("admin.roles.view_permissions")}</summary><div>{role.permissions.map((permission) => <code key={permission}>{permission}</code>)}</div></details>
    </article>)}</div>
    <div className="role-matrix"><header><div><p className="eyebrow">{t("admin.roles.assignments")}</p><h3>{t("admin.roles.assignment_title")}</h3></div><span>{canManage ? t("admin.manage") : t("admin.read_only")}</span></header>
      <DirectoryControls page={overview?.identityPage} busy={state === "loading" || saving} onLoad={refresh} t={t} />
      <div className="role-matrix__scroll"><table><thead><tr><th>{t("admin.roles.account")}</th>{roles.map((role) => <th key={role.roleKey}>{t(`role.${role.roleKey}`)}</th>)}</tr></thead>
      <tbody>{overview?.identities.map((identity) => <tr key={identity.id} data-role-identity={identity.loginName}><th><strong>{identity.displayName}</strong><small>@{identity.loginName}{identity.id === actorIdentityId ? ` · ${t("admin.users.you")}` : ""}</small><em>{t(`admin.users.${identity.status}`)}</em></th>{roles.map((role) => {
        const granted = identity.roles.includes(role.roleKey);
        return <td key={role.roleKey}><button type="button" className={`role-toggle ${granted ? "role-toggle--granted" : ""}`} disabled={!canManage || identity.status !== "active"} aria-pressed={granted} aria-label={t(granted ? "admin.roles.revoke_label" : "admin.roles.grant_label", { name: identity.displayName, role: t(`role.${role.roleKey}`) })} onClick={() => setPending({ identity, role, granted: !granted })}>{granted ? <Check size={14} /> : <X size={14} />}</button></td>;
      })}</tr>)}</tbody></table></div>
    </div>
    {pending && <EditorDialog closeLabel={t("common.close")} title={t(pending.granted ? "admin.roles.confirm_grant" : "admin.roles.confirm_revoke", { name: pending.identity.displayName, role: t(`role.${pending.role.roleKey}`) })} description={t("admin.roles.confirm_hint")} busy={saving} feedback={errorCode && t(`admin.roles.error.${errorCode}`)} onCancel={() => setPending(null)}><footer><button type="button" disabled={saving} onClick={() => setPending(null)}>{t("common.cancel")}</button><button type="button" className="primary-button" disabled={saving} onClick={() => void apply()}>{saving && <LoaderCircle className="auth-spinner" size={13} />}{t("admin.roles.confirm")}</button></footer></EditorDialog>}  </section>;
}

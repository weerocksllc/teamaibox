import { AlertTriangle, Blocks, Box, CheckCircle2, CircleOff, Download, LoaderCircle, PackageCheck, PackagePlus, RefreshCw, RotateCcw, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { InlineEditor } from "../InlineEditor";

import { importPlugin, loadPluginAdministration, operatePlugin, type ManagedPlugin, type PluginAdministration, type PluginImport } from "./plugin-administration-client";

type Translate = (key: string, values?: Record<string, string | number>) => string;
type SourceKind = "marketplace" | "private-registry" | "offline-bundle";

function newer(left: string, right: string) {
  const parts = (value: string) => value.split("-", 1)[0].split(".").map(Number);
  const a = parts(left), b = parts(right);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] > b[index];
  return false;
}
function compact(value: string) { return value.length > 27 ? `${value.slice(0, 18)}…${value.slice(-8)}` : value; }

export function PluginAdministrationPanel({ canManage, t }: { canManage: boolean; t: Translate }) {
  const [data, setData] = useState<PluginAdministration | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [composer, setComposer] = useState(false);
  const [sourceKind, setSourceKind] = useState<SourceKind>("marketplace");

  const load = async () => {
    setError(null);
    try { setData(await loadPluginAdministration()); setState("ready"); }
    catch (failure: any) { setError(failure?.code ?? "request_failed"); setState("error"); }
  };
  useEffect(() => { void load(); }, []);
  const summary = useMemo(() => ({
    verified: data?.imports.filter((item) => item.state === "verified").length ?? 0,
    enabled: data?.plugins.filter((item) => item.lifecycleState === "enabled").length ?? 0,
    applications: data?.imports.filter((item) => item.pluginType === "ApplicationPlugin").length ?? 0,
    compute: data?.imports.filter((item) => item.pluginType === "ComputePlugin").length ?? 0,
  }), [data]);
  const act = async (key: string, operation: () => Promise<unknown>, successKey: string) => {
    setBusy(key); setError(null); setNotice(null);
    try { await operation(); await load(); setNotice(t(successKey)); }
    catch (failure: any) { setError(failure?.code ?? "request_failed"); }
    finally { setBusy(null); }
  };
  const submit = (form: HTMLFormElement) => {
    const values = new FormData(form), input: Record<string, unknown> = { sourceKind };
    if (sourceKind === "marketplace") Object.assign(input, { pluginId: String(values.get("pluginId")), version: String(values.get("version")) });
    else if (sourceKind === "private-registry") input.reference = String(values.get("reference"));
    else Object.assign(input, { bundleId: String(values.get("bundleId")), expectedBundleDigest: String(values.get("expectedBundleDigest")) });
    void act("import", async () => { await importPlugin(input); setComposer(false); }, "admin.plugins.imported");
  };

  if (state === "loading") return <div className="plugin-admin-state" role="status" aria-live="polite" aria-busy="true"><LoaderCircle className="auth-spinner" size={22} aria-hidden="true" />{t("admin.plugins.loading")}</div>;
  return <section className="plugin-admin" aria-labelledby="plugin-admin-title">
    <header className="plugin-admin__header"><div><p className="eyebrow">{t("presentation.label_2")}</p><h2 id="plugin-admin-title">{t("admin.plugins.workspace")}</h2><p>{t("admin.plugins.workspace_description")}</p></div><div><button type="button" className="secondary-button" disabled={busy !== null} onClick={() => void load()}><RefreshCw size={14} />{t("admin.plugins.refresh")}</button>{canManage && <button type="button" className="primary-button" disabled={busy !== null} aria-expanded={composer} onClick={() => setComposer((value) => !value)}><PackagePlus size={14} />{t("admin.plugins.import")}</button>}</div></header>
    {error && <div className="plugin-admin__error" role="alert"><AlertTriangle size={15} />{t("admin.plugins.error")}<code>{error}</code></div>}
    {notice && <div className="plugin-admin__notice" role="status"><CheckCircle2 size={15} />{notice}</div>}
    <div className="plugin-admin__summary"><article><PackageCheck size={18} /><span><strong>{summary.verified}</strong>{t("admin.plugins.verified")}</span></article><article><CheckCircle2 size={18} /><span><strong>{summary.enabled}</strong>{t("admin.plugins.enabled")}</span></article><article><Blocks size={18} /><span><strong>{summary.applications}</strong>{t("admin.plugins.application_type")}</span></article><article><Box size={18} /><span><strong>{summary.compute}</strong>{t("admin.plugins.compute_type")}</span></article></div>
    {composer && <InlineEditor title={t("admin.plugins.import_title")} feedback={error && t("admin.plugins.error")} busy={busy !== null} cancelLabel={t("common.cancel")} onCancel={() => setComposer(false)}><form className="plugin-import" onSubmit={(event) => { event.preventDefault(); submit(event.currentTarget); }}><div className="plugin-import__heading"><div><strong>{t("admin.plugins.import_title")}</strong><small>{t("admin.plugins.import_hint")}</small></div><ShieldCheck size={20} /></div><label>{t("admin.plugins.source")}<select value={sourceKind} onChange={(event) => setSourceKind(event.target.value as SourceKind)}><option value="marketplace">{t("admin.plugins.source_marketplace")}</option><option value="private-registry">{t("admin.plugins.source_registry")}</option><option value="offline-bundle">{t("admin.plugins.source_offline")}</option></select></label>{sourceKind === "marketplace" && <><label>{t("admin.plugins.plugin_id")}<input name="pluginId" required pattern="[a-z][a-z0-9.-]{2,127}" placeholder="example.team-notes" /></label><label>{t("admin.plugins.version")}<input name="version" required pattern="[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?" placeholder="1.0.0" /></label></>}{sourceKind === "private-registry" && <label className="plugin-import__wide">{t("admin.plugins.reference")}<input name="reference" required minLength={8} maxLength={512} placeholder="registry.internal/team-notes@sha256:…" /></label>}{sourceKind === "offline-bundle" && <><label>{t("admin.plugins.bundle_id")}<input name="bundleId" required minLength={8} maxLength={256} /></label><label>{t("admin.plugins.bundle_digest")}<input name="expectedBundleDigest" required pattern="sha256:[a-f0-9]{64}" placeholder="sha256:…" /></label></>}<button type="submit" className="primary-button" disabled={busy !== null}>{busy === "import" ? <LoaderCircle className="auth-spinner" size={14} /> : <Download size={14} />}{t("admin.plugins.verify_import")}</button></form></InlineEditor>}
    <div className="plugin-admin__boundary"><ShieldCheck size={15} /><div><strong>{t("admin.plugins.boundary_title")}</strong><small>{t("admin.plugins.boundary_hint", { architecture: data?.architecture ?? "linux/arm64/v8" })}</small></div></div>
    {!data || (data.plugins.length === 0 && data.imports.length === 0) ? <div className="plugin-admin-state"><Blocks size={26} />{t("admin.plugins.empty")}</div> : <PluginInventory data={data} canManage={canManage} busy={busy} act={act} t={t} />}
  </section>;
}

function PluginInventory({ data, canManage, busy, act, t }: { data: PluginAdministration; canManage: boolean; busy: string | null; act: (key: string, operation: () => Promise<unknown>, successKey: string) => Promise<void>; t: Translate }) {
  const ids = [...new Set([...data.plugins.map((item) => item.pluginId), ...data.imports.map((item) => item.pluginId)])].sort();
  return <div className="plugin-inventory">{ids.map((pluginId) => <PluginCard key={pluginId} plugin={data.plugins.find((item) => item.pluginId === pluginId) ?? null} imports={data.imports.filter((item) => item.pluginId === pluginId)} canManage={canManage} busy={busy} act={act} t={t} />)}</div>;
}

function PluginCard({ plugin, imports, canManage, busy, act, t }: { plugin: ManagedPlugin | null; imports: PluginImport[]; canManage: boolean; busy: string | null; act: (key: string, operation: () => Promise<unknown>, successKey: string) => Promise<void>; t: Translate }) {
  const pluginId = plugin?.pluginId ?? imports[0].pluginId, type = plugin?.pluginType ?? imports[0].pluginType;
  const versions = [...imports].sort((left, right) => right.version.localeCompare(left.version));
  const installVersion = versions[0]?.version, upgrade = plugin?.currentVersion ? versions.find((item) => newer(item.version, plugin.currentVersion!))?.version : null;
  const active = plugin?.lifecycleState === "enabled", installed = Boolean(plugin?.currentVersion), locked = plugin?.protectedOfficial === true;
  const operate = (operation: "install" | "enable" | "disable" | "upgrade" | "uninstall", version: string | undefined, message: string) => act(`${pluginId}:${operation}`, () => operatePlugin(pluginId, operation, version), message);
  return <article className={`plugin-card plugin-card--${plugin?.lifecycleState ?? "verified"}`} data-plugin-id={pluginId}><header><span>{type === "ApplicationPlugin" ? <Blocks size={18} /> : <Box size={18} />}</span><div><strong>{pluginId}</strong><small>{t(type === "ApplicationPlugin" ? "admin.plugins.application_type" : "admin.plugins.compute_type")} · {plugin?.publisherId ?? t("admin.plugins.verified_import")}</small></div><em>{t(`admin.plugins.state.${plugin?.lifecycleState ?? "verified"}`)}</em></header><div className="plugin-card__facts"><span>{t("admin.plugins.current")}<strong>{plugin?.currentVersion ?? "—"}</strong></span><span>{t("admin.plugins.slot")}<strong>{plugin?.activeSlot ?? "—"}</strong></span><span>{t("admin.plugins.generation")}<strong>{plugin?.generation ?? 0}</strong></span><span>{t("admin.plugins.data")}<strong>{plugin?.dataRetentionState ?? "—"}</strong></span></div><div className="plugin-card__versions">{versions.map((item) => <span key={item.version}><PackageCheck size={12} /><strong>{item.version}</strong><code title={item.bundlePayloadDigest}>{compact(item.bundlePayloadDigest)}</code></span>)}</div>{canManage && <footer>{!installed && installVersion && <button type="button" disabled={busy !== null} onClick={() => void operate("install", installVersion, "admin.plugins.installed")}><PackagePlus size={12} />{t("admin.plugins.install")}</button>}{installed && upgrade && <button type="button" disabled={busy !== null} onClick={() => void operate("upgrade", upgrade, "admin.plugins.upgraded")}><RotateCcw size={12} />{t("admin.plugins.upgrade_to", { version: upgrade })}</button>}{installed && !locked && <button type="button" disabled={busy !== null} onClick={() => void operate(active ? "disable" : "enable", undefined, active ? "admin.plugins.disabled" : "admin.plugins.enabled_notice")}>{active ? <CircleOff size={12} /> : <CheckCircle2 size={12} />}{t(active ? "admin.plugins.disable" : "admin.plugins.enable")}</button>}{installed && !locked && <button type="button" className="danger-button" disabled={busy !== null} onClick={() => void operate("uninstall", undefined, "admin.plugins.uninstalled")}><Trash2 size={12} />{t("admin.plugins.uninstall")}</button>}{locked && <span><ShieldCheck size={12} />{t("admin.plugins.protected")}</span>}</footer>}</article>;
}

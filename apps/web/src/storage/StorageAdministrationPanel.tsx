import { AlertTriangle, CheckCircle2, Database, HardDrive, LoaderCircle, LockKeyhole, Plus, RefreshCw, Save, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { InlineEditor } from "../InlineEditor";

import { loadStorageAdministration, registerStoragePool, replaceStorageDataClasses, transitionStoragePool,
  type StorageAdministration, type StorageDataClass, type StoragePool } from "./storage-client";

const GIB = 1024 ** 3;
function bytes(value: number | null, locale: string) { if (value == null) return "—"; return new Intl.NumberFormat(locale, { style: "unit", unit: value >= GIB ? "gigabyte" : "megabyte", unitDisplay: "short", maximumFractionDigits: 1 }).format(value / (value >= GIB ? GIB : 1024 ** 2)); }
function expected(pool: StoragePool) { return pool.lifecycleState === "active" ? `DRAIN ${pool.poolId}` : pool.lifecycleState === "draining" ? `DRAINED ${pool.poolId}` : `REMOVE ${pool.poolId}`; }
function action(pool: StoragePool): "drain" | "complete" | "remove" { return pool.lifecycleState === "active" ? "drain" : pool.lifecycleState === "draining" ? "complete" : "remove"; }

function RegisterPool({ classes, busy, t, onRegister }: { classes: StorageDataClass[]; busy: boolean; t: (key: string, values?: Record<string, string | number>) => string; onRegister: (input: Parameters<typeof registerStoragePool>[0]) => void }) {
  const [backend, setBackend] = useState<StoragePool["backendKind"]>("local-filesystem"), [poolId, setPoolId] = useState("local.data");
  return <form className="storage-register" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget), local = backend !== "s3-compatible";
    onRegister({ poolId, displayName: String(form.get("displayName")), backendKind: backend, nodeId: local ? String(form.get("nodeId")) : null,
      failureDomain: String(form.get("failureDomain")), totalBytes: Number(form.get("totalGiB")) * GIB, availableBytes: Number(form.get("availableGiB")) * GIB,
      safetyReserveBytes: Number(form.get("reserveGiB")) * GIB, encryptionMode: local ? "luks2" : "provider-managed", dataClasses: classes,
      verificationConfirmation: String(form.get("confirmation")) }); }}>
    <header><div><strong>{t("storage.register.title")}</strong><small>{t("storage.register.subtitle")}</small></div><ShieldCheck size={19} /></header>
    <div className="storage-form-grid">
      <label>{t("storage.pool_id")}<input value={poolId} onChange={(event) => setPoolId(event.target.value)} pattern="[a-z][a-z0-9_.-]{2,127}" required /></label>
      <label>{t("storage.display_name")}<input name="displayName" required /></label>
      <label>{t("storage.backend")}<select value={backend} onChange={(event) => setBackend(event.target.value as StoragePool["backendKind"])}><option value="local-filesystem">{t("presentation.label_46")}</option><option value="local-block">{t("presentation.label_47")}</option><option value="s3-compatible">{t("presentation.label_48")}</option></select></label>
      {backend !== "s3-compatible" && <label>{t("storage.node_id")}<input name="nodeId" pattern="[0-9a-fA-F-]{36}" required /></label>}
      <label>{t("storage.failure_domain")}<input name="failureDomain" defaultValue="appliance.primary" pattern="[a-z][a-z0-9_.-]{2,127}" required /></label>
      <label>{t("storage.total_gib")}<input name="totalGiB" type="number" min="1" defaultValue="100" required /></label>
      <label>{t("storage.available_gib")}<input name="availableGiB" type="number" min="0" defaultValue="90" required /></label>
      <label>{t("storage.reserve_gib")}<input name="reserveGiB" type="number" min="0" defaultValue="10" required /></label>
      <label className="storage-form-wide">{t("storage.verification")}<input name="confirmation" placeholder={`VERIFIED ${poolId}`} required /></label>
    </div><button className="primary-button" disabled={busy}><Plus size={14} />{t(busy ? "storage.register.running" : "storage.register.submit")}</button>
  </form>;
}

function PoolCard({ pool, classes, locale, canManage, busy, t, mutate }: { pool: StoragePool; classes: StorageDataClass[]; locale: string; canManage: boolean; busy: boolean; t: (key: string, values?: Record<string, string | number>) => string; mutate: (operation: () => Promise<unknown>) => void }) {
  const [selected, setSelected] = useState<StorageDataClass[]>(pool.dataClasses), [confirmation, setConfirmation] = useState("");
  useEffect(() => setSelected(pool.dataClasses), [pool.updatedAt]);
  const blockers = pool.allocationCount + pool.liveReservationCount + pool.incompleteMigrationCount;
  const lifecycle = pool.lifecycleState !== "removed" && new Set(["active", "draining", "drained"]).has(pool.lifecycleState);
  const exact = expected(pool), lifecycleAction = action(pool);
  return <article className={`storage-pool storage-pool--${pool.healthState}`}>
    <header><span><HardDrive size={19} /></span><div><strong>{pool.displayName}</strong><small>{pool.poolId} · {pool.backendKind}</small></div><b>{t(`storage.lifecycle.${pool.lifecycleState}`)}</b></header>
    <div className="storage-capacity"><div><span>{t("storage.available")}</span><strong>{bytes(pool.availableBytes, locale)} / {bytes(pool.totalBytes, locale)}</strong></div><progress max={pool.totalBytes ?? 1} value={(pool.totalBytes ?? 0) - (pool.availableBytes ?? 0)} /></div>
    <div className="storage-proof"><span><LockKeyhole size={14} />{pool.encryptionMode} · {t(`storage.status.${pool.encryptionStatus}`)}</span><span><CheckCircle2 size={14} />{t("storage.compatibility")} · {t(`storage.status.${pool.compatibilityStatus}`)}</span><span className={`storage-health storage-health--${pool.healthState}`}>{t(`storage.health.${pool.healthState}`)}</span></div>
    <dl><div><dt>{t("storage.allocations")}</dt><dd>{pool.allocationCount} · {bytes(pool.allocatedBytes, locale)}</dd></div><div><dt>{t("storage.reservations")}</dt><dd>{pool.liveReservationCount} · {bytes(pool.liveReservationBytes, locale)}</dd></div><div><dt>{t("storage.migrations")}</dt><dd>{pool.incompleteMigrationCount}</dd></div><div><dt>{t("storage.failure_domain")}</dt><dd>{pool.failureDomain}</dd></div></dl>
    <fieldset disabled={!canManage || pool.lifecycleState !== "active" || busy}><legend>{t("storage.data_classes")}</legend><div>{classes.map((item) => <label key={item}><input type="checkbox" checked={selected.includes(item)} onChange={() => setSelected((current) => current.includes(item) ? current.filter((value) => value !== item) : [...current, item])} />{t(`storage.class.${item}`)}</label>)}</div>
      <button type="button" className="secondary-button" disabled={selected.length < 1 || JSON.stringify([...selected].sort()) === JSON.stringify([...pool.dataClasses].sort())} onClick={() => mutate(() => replaceStorageDataClasses(pool, selected))}><Save size={13} />{t("storage.classes.save")}</button></fieldset>
    {lifecycle && <div className="storage-lifecycle"><div><strong>{t(`storage.action.${lifecycleAction}`)}</strong><small>{t(blockers > 0 && pool.lifecycleState === "draining" ? "storage.blocked" : "storage.action_hint")}</small></div><label><span className="sr-only">{exact}</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder={exact} /></label><button type="button" className={lifecycleAction === "remove" ? "danger-button" : "secondary-button"} disabled={!canManage || busy || confirmation !== exact} onClick={() => mutate(() => transitionStoragePool(pool, lifecycleAction, confirmation))}>{lifecycleAction === "remove" ? <Trash2 size={13} /> : <Database size={13} />}{t(`storage.action.${lifecycleAction}`)}</button></div>}
  </article>;
}

export function StorageAdministrationPanel({ locale, canManage, t }: { locale: string; canManage: boolean; t: (key: string, values?: Record<string, string | number>) => string }) {
  const [data, setData] = useState<StorageAdministration | null>(null), [state, setState] = useState<"loading" | "ready" | "error">("loading"), [busy, setBusy] = useState(false), [composer, setComposer] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const refreshing = useRef(false);
  const refresh = async () => { if (refreshing.current) return; refreshing.current = true; setState("loading"); try { setData(await loadStorageAdministration()); setState("ready"); } catch { setState("error"); } finally { refreshing.current = false; } };
  useEffect(() => { void refresh(); }, []);
  const mutate = async (operation: () => Promise<unknown>) => { if (busy) return; setBusy(true); setNotice(null); try { await operation(); setNotice(t("storage.action_succeeded")); setComposer(false); await refresh(); } catch { setNotice(t("storage.action_failed")); } finally { setBusy(false); } };
  return <section className="storage-panel" aria-labelledby="storage-panel-title"><header className="storage-panel__header"><div><p className="eyebrow">{t("storage.eyebrow")}</p><h2 id="storage-panel-title">{t("storage.title")}</h2><p>{t("storage.subtitle")}</p></div><div><button type="button" className="secondary-button" disabled={busy || state === "loading"} onClick={() => void refresh()}><RefreshCw size={14} />{t("storage.refresh")}</button>{canManage && <button type="button" className="primary-button" disabled={busy} aria-expanded={composer} onClick={() => setComposer((value) => !value)}><Plus size={14} />{t("storage.register.open")}</button>}</div></header>
    {notice && <p className="storage-notice" role="status">{notice}</p>}
    {state === "loading" && <div className="storage-state" role="status" aria-live="polite" aria-busy="true"><LoaderCircle className="auth-spinner" size={18} aria-hidden="true" />{t("storage.loading")}</div>}
    {state === "error" && <div className="storage-state storage-state--error" role="alert"><AlertTriangle size={18} aria-hidden="true" />{t("storage.error")}</div>}
    {data && <>
      <div className="storage-summary"><div><span>{t("storage.summary.pools")}</span><strong>{data.summary.activePoolCount} / {data.summary.poolCount}</strong></div><div><span>{t("storage.summary.capacity")}</span><strong>{bytes(data.summary.availableBytes, locale)} / {bytes(data.summary.totalBytes, locale)}</strong></div><div><span>{t("storage.summary.allocated")}</span><strong>{bytes(data.summary.allocatedBytes, locale)}</strong></div><div><span>{t("storage.summary.degraded")}</span><strong>{data.summary.degradedPoolCount}</strong></div></div>
      {composer && <InlineEditor title={t("storage.register.open")} feedback={notice} busy={busy} cancelLabel={t("common.cancel")} onCancel={() => setComposer(false)}><RegisterPool classes={data.dataClasses} busy={busy} t={t} onRegister={(input) => void mutate(() => registerStoragePool(input))} /></InlineEditor>}
      {data.pools.length === 0 ? <div className="storage-state"><HardDrive size={18} />{t("storage.empty")}</div> : <div className="storage-pool-grid">{data.pools.map((pool) => <PoolCard key={pool.poolId} pool={pool} classes={data.dataClasses} locale={locale} canManage={canManage} busy={busy} t={t} mutate={(operation) => void mutate(operation)} />)}</div>}
    </>}
  </section>;
}

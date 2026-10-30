import { AlertTriangle, CheckCircle2, Cloud, Database, HardDrive, LoaderCircle, PackagePlus, RefreshCw, Route, ScanLine, ShieldCheck, Usb, WifiOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { InlineEditor } from "../InlineEditor";
import { sourceErrorKey } from "./source-error";

import { approveOfflineMedia, createSoftwareSource, createSourcePolicy, discoverOfflineMedia, loadSourceCenter, updateSoftwareSource, type Ecosystem, type OfflineMedia, type SoftwareSource, type SourceDataPlanes, type SourceOverview, type SourcePolicy } from "./source-center-client";

const ecosystems: Ecosystem[] = ["pip", "npm", "apt"];
const emptyOverview: SourceOverview = { schemaVersion: 1, sourceCount: 0, policyCount: 0, byEcosystem: { pip: { sources: 0, enabled: 0, healthy: 0, offline: 0, policies: 0 }, npm: { sources: 0, enabled: 0, healthy: 0, offline: 0, policies: 0 }, apt: { sources: 0, enabled: 0, healthy: 0, offline: 0, policies: 0 } } };
const emptyDataPlanes: SourceDataPlanes = { schemaVersion: 1, state: "unavailable", observedAt: new Date(0).toISOString(), errorCode: "source_gateway_not_loaded", ecosystems: { pip: { requests: null, cacheHits: null, upstreamFetches: null, upstreamBytes: null }, npm: { requests: null, cacheHits: null, upstreamFetches: null, upstreamBytes: null }, apt: { requests: null, cacheHits: null, upstreamFetches: null, upstreamBytes: null } } };

export function SourceCenterPanel({ canManage, t }: { canManage: boolean; t: (key: string) => string }) {
  const [overview, setOverview] = useState(emptyOverview);
  const [dataPlanes, setDataPlanes] = useState(emptyDataPlanes);
  const [sources, setSources] = useState<SoftwareSource[]>([]);
  const [policies, setPolicies] = useState<SourcePolicy[]>([]);
  const [media, setMedia] = useState<OfflineMedia[]>([]);
  const [ecosystem, setEcosystem] = useState<Ecosystem>("pip");
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const loadingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState<"source" | "policy" | null>(null);

  const load = async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true); setError(null);
    try { const value = await loadSourceCenter(); setOverview(value.overview); setDataPlanes(value.dataPlanes); setSources(value.sources); setPolicies(value.policies); setMedia(value.media); }
    catch (error) { setError(sourceErrorKey(error)); }
    finally { loadingRef.current = false; setLoading(false); setLoaded(true); }
  };
  useEffect(() => { void load(); }, []);

  const visibleSources = useMemo(() => sources.filter((source) => source.ecosystem === ecosystem), [sources, ecosystem]);
  const visiblePolicies = useMemo(() => policies.filter((policy) => policy.ecosystem === ecosystem), [policies, ecosystem]);

  const submitSource = async (form: FormData) => {
    setSaving(true); setError(null);
    const kind = String(form.get("kind")); const networkZone = String(form.get("networkZone"));
    try {
      await createSoftwareSource({
        sourceKey: String(form.get("sourceKey")), displayName: String(form.get("displayName")), ecosystem, kind,
        endpoint: { url: String(form.get("url")), networkZone }, priority: Number(form.get("priority")),
        packageScopes: String(form.get("packageScopes")).split(",").map((value) => value.trim()).filter(Boolean),
        architectures: String(form.get("architectures")).split(",").map((value) => value.trim()).filter(Boolean),
        trust: { checksumRequired: true, signaturePolicy: String(form.get("signaturePolicy")) },
        credentialSecretKey: String(form.get("credentialSecretKey")) || null,
        onlineMode: String(form.get("onlineMode")),
        cache: { mode: String(form.get("cacheMode")), maximumBytes: Number(form.get("maximumBytes")), ttlSeconds: Number(form.get("ttlSeconds")), retainVerified: true },
        storagePoolId: String(form.get("storagePoolId")) || null, enabled: true,
      });
      setComposer(null); await load();
    } catch (error) { setError(sourceErrorKey(error)); } finally { setSaving(false); }
  };

  const submitPolicy = async (form: FormData) => {
    setSaving(true); setError(null);
    try {
      await createSourcePolicy({
        policyKey: String(form.get("policyKey")), displayName: String(form.get("displayName")), ecosystem,
        environment: String(form.get("environment")), selector: { teamKey: String(form.get("teamKey")) || null, sandboxProfileKey: String(form.get("sandboxProfileKey")) || null, architecture: String(form.get("architecture")) },
        offlineMode: String(form.get("offlineMode")),
        sources: visibleSources.map((source, index) => ({ sourceId: source.sourceId, priority: (index + 1) * 10 })), packageRules: [], enabled: true,
      });
      setComposer(null); await load();
    } catch (error) { setError(sourceErrorKey(error)); } finally { setSaving(false); }
  };

  if (loading && !loaded) return <div className="source-center-state" role="status" aria-live="polite" aria-busy="true"><LoaderCircle className="auth-spinner" size={23} aria-hidden="true" />{t("admin.sources.loading")}</div>;
  return (
    <section className="source-center" aria-label={t("admin.sources.workspace")}>
      <header className="source-center__header">
        <div><p className="eyebrow">{t("presentation.label_5")}</p><h2>{t("admin.sources.workspace")}</h2><p>{t("admin.sources.workspace_description")}</p></div>
        <div><button type="button" className="secondary-button" disabled={loading || saving} onClick={() => void load()}><RefreshCw size={14} />{t("admin.sources.refresh")}</button>{canManage && <button type="button" className="primary-button" disabled={saving} aria-expanded={composer === "source"} aria-controls="source-composer" onClick={() => setComposer(composer === "source" ? null : "source")}><PackagePlus size={14} />{t("admin.sources.add")}</button>}</div>
      </header>
      {error && <div className="source-center-error" role="alert"><AlertTriangle size={16} />{t(error)}</div>}
      {loading && <p role="status" aria-live="polite">{t("admin.sources.loading")}</p>}
      <div className="source-center-summary" role="group" aria-label={t("admin.sources.ecosystems")}>
        {ecosystems.map((item) => { const itemOverview = overview.byEcosystem[item]; return <button key={item} type="button" disabled={saving || composer !== null} className={item === ecosystem ? "is-active" : ""} aria-pressed={item === ecosystem} onClick={() => setEcosystem(item)}><span>{item.toUpperCase()}</span><strong>{itemOverview.enabled}/{itemOverview.sources}</strong><small>{itemOverview.healthy} {t("admin.sources.healthy")} · {itemOverview.policies} {t("admin.sources.policies")}</small></button>; })}
      </div>
      <details className={`source-data-planes source-data-planes--${dataPlanes.state}`} aria-label={t("admin.sources.data_planes")}>
        <summary><strong>{t("admin.sources.data_planes")}</strong><span>{t(`admin.sources.data_plane.${dataPlanes.state}`)}</span></summary>
        <div>{ecosystems.map((item) => { const facts = dataPlanes.ecosystems[item]; return <article key={item}><strong>{item.toUpperCase()}</strong><dl><div><dt>{t("admin.sources.requests")}</dt><dd>{facts.requests ?? "—"}</dd></div><div><dt>{t("admin.sources.cache_hits")}</dt><dd>{facts.cacheHits ?? "—"}</dd></div><div><dt>{t("admin.sources.upstream_fetches")}</dt><dd>{facts.upstreamFetches ?? "—"}</dd></div><div><dt>{t("admin.sources.upstream_bytes")}</dt><dd>{facts.upstreamBytes === null ? "—" : formatBytes(facts.upstreamBytes)}</dd></div></dl></article>; })}</div>
      </details>
      {composer === "source" && <Composer id="source-composer" saving={saving} feedback={error && t(error)} t={t} onClose={() => setComposer(null)}><SourceForm ecosystem={ecosystem} saving={saving} t={t} onSubmit={submitSource} /></Composer>}
      <div className="source-center-grid">
        <section className="source-list"><div className="source-section-heading"><div><h3>{t("admin.sources.routes")}</h3><span>{visibleSources.length}</span></div><small>{t("admin.sources.routes_hint")}</small></div>
          {visibleSources.length === 0 ? <div className="source-empty"><Database size={24} /><p>{t("admin.sources.empty")}</p></div> : visibleSources.map((source) => <SourceCard key={source.sourceId} source={source} canManage={canManage} saving={saving} t={t} onToggle={async () => { setSaving(true); try { await updateSoftwareSource(source, { enabled: !source.enabled }); await load(); } catch (error) { setError(sourceErrorKey(error)); } finally { setSaving(false); } }} />)}
        </section>
        <aside className="source-policy-panel"><div className="source-section-heading"><div><h3>{t("admin.sources.policies")}</h3><span>{visiblePolicies.length}</span></div>{canManage && visibleSources.length > 0 && <button type="button" disabled={saving} aria-expanded={composer === "policy"} aria-controls="policy-composer" onClick={() => setComposer(composer === "policy" ? null : "policy")}><Route size={13} />{t("admin.sources.add_policy")}</button>}</div>
          {composer === "policy" && <Composer id="policy-composer" saving={saving} feedback={error && t(error)} t={t} onClose={() => setComposer(null)}><PolicyForm saving={saving} t={t} onSubmit={submitPolicy} /></Composer>}
          {visiblePolicies.length === 0 ? <div className="source-empty source-empty--compact"><Route size={22} /><p>{t("admin.sources.policy_empty")}</p></div> : visiblePolicies.map((policy) => <article className="source-policy-card" key={policy.policyId}><header><strong>{policy.displayName}</strong><span>{policy.environment}</span></header><code>{policy.policyKey}</code><div><span>{policy.selector.architecture}</span><span>{policy.offlineMode}</span><span>{policy.sources.length} {t("admin.sources.routes")}</span></div>{policy.packageRules.length > 0 && <small>{policy.packageRules.length} {t("admin.sources.rules")}</small>}</article>)}
        </aside>
      </div>
      <section className="offline-media-panel">
        <div className="source-section-heading"><div><h3>{t("admin.sources.offline_media")}</h3><span>{media.length}</span></div><small>{t("admin.sources.offline_media_hint")}</small></div>
        {canManage && <form className="offline-media-discovery" onSubmit={async (event) => { event.preventDefault(); setSaving(true); setError(null); try { await discoverOfflineMedia(String(new FormData(event.currentTarget).get("nodeId"))); await load(); } catch (error) { setError(sourceErrorKey(error)); } finally { setSaving(false); } }}><label>{t("admin.sources.node_id")}<input name="nodeId" required pattern="[0-9a-fA-F-]{36}" placeholder="00000000-0000-4000-8000-000000000001" /></label><button className="secondary-button" disabled={saving} type="submit"><ScanLine size={14} />{t("admin.sources.discover")}</button></form>}
        {media.length === 0 ? <div className="source-empty source-empty--compact"><Usb size={22} /><p>{t("admin.sources.offline_empty")}</p></div> : <div className="offline-media-grid">{media.map((item) => <OfflineMediaCard key={item.mediaId} media={item} canManage={canManage} saving={saving} t={t} onApprove={async () => { setSaving(true); setError(null); try { await approveOfflineMedia(item); await load(); } catch (error) { setError(sourceErrorKey(error)); } finally { setSaving(false); } }} />)}</div>}
      </section>
    </section>
  );
}

function Composer({ id, saving, feedback, t, onClose, children }: { id: string; saving: boolean; feedback: ReactNode; t: (key: string) => string; onClose: () => void; children: ReactNode }) {
  return <InlineEditor title={t(id === "source-composer" ? "admin.sources.new_source" : "admin.sources.add_policy")} feedback={feedback} busy={saving} cancelLabel={t("common.cancel")} onCancel={onClose}><div id={id}>{children}</div></InlineEditor>;
}

function formatBytes(value: number) { if (value < 1024) return `${value} B`; if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`; return `${(value / 1024 ** 2).toFixed(1)} MiB`; }

function OfflineMediaCard({ media, canManage, saving, t, onApprove }: { media: OfflineMedia; canManage: boolean; saving: boolean; t: (key: string) => string; onApprove: () => void }) {
  const healthy = media.health.state === "healthy"; const detached = media.availability === "detached";
  return <article className={`offline-media-card ${detached ? "is-detached" : ""}`}><header><span className={`source-health source-health--${media.health.state}`}>{detached ? <WifiOff size={15} /> : healthy ? <CheckCircle2 size={15} /> : <HardDrive size={15} />}</span><div><strong>{media.volumeLabel}</strong><code>{media.filesystemUuid}</code></div><em>{media.transport.toUpperCase()}</em></header><div className="source-card__facts"><span>{media.filesystemType}</span><span>{media.availability}</span><span>{media.approvalState}</span><span>{media.lifecycleState}</span></div><div className="offline-media-capacity"><span>{(media.capacityBytes / 1024 ** 3).toFixed(1)} GiB</span><code>{media.observedManifestSha256.slice(0, 22)}…</code></div>{media.inventory && <div className="offline-media-inventory"><span><strong>{media.inventory.packageCount}</strong>{t("admin.sources.packages")}</span><span><strong>{media.inventory.artifactCount}</strong>{t("admin.sources.artifacts")}</span><span><strong>{media.inventory.missingDependencies.length}</strong>{t("admin.sources.missing")}</span><span><strong>{media.inventory.architectures.join(" · ")}</strong>{t("admin.sources.architecture")}</span></div>}<footer><small>{media.health.errorCode ? t(`admin.sources.health.${media.health.errorCode}`) : t(`admin.sources.health.${media.health.state}`)}</small>{canManage && media.availability === "attached" && media.approvalState !== "approved" && <button type="button" disabled={saving} onClick={onApprove}><ShieldCheck size={12} />{t("admin.sources.approve_media")}</button>}</footer></article>;
}

function SourceCard({ source, canManage, saving, t, onToggle }: { source: SoftwareSource; canManage: boolean; saving: boolean; t: (key: string) => string; onToggle: () => void }) {
  const HealthIcon = source.health.state === "healthy" ? CheckCircle2 : source.health.state === "offline" || source.health.state === "detached" ? WifiOff : Cloud;
  return <article className={`source-card ${source.enabled ? "" : "is-disabled"}`}><header><span className={`source-health source-health--${source.health.state}`}><HealthIcon size={15} /></span><div><strong>{source.displayName}</strong><code>{source.sourceKey}</code></div><em>{source.priority}</em></header><a href={source.endpoint.url} target="_blank" rel="noreferrer">{source.endpoint.url}</a><div className="source-card__facts"><span>{source.kind}</span><span>{source.endpoint.networkZone}</span><span>{source.onlineMode}</span><span>{source.cache.mode}</span></div><div className="source-card__scopes"><span><HardDrive size={12} />{source.architectures.join(" · ")}</span><span><ShieldCheck size={12} />SHA · {source.trust.signaturePolicy}{source.trust.tlsRequired ? " · TLS" : ""}</span></div><footer><small>{source.packageScopes.join(", ")}</small>{source.credentialConfigured && <span>{t("admin.sources.credential")}</span>}{canManage && <button type="button" disabled={saving} onClick={onToggle}>{t(source.enabled ? "admin.sources.disable" : "admin.sources.enable")}</button>}</footer></article>;
}

function SourceForm({ ecosystem, saving, t, onSubmit }: { ecosystem: Ecosystem; saving: boolean; t: (key: string) => string; onSubmit: (form: FormData) => void }) {
  return <form className="source-composer" onSubmit={(event) => { event.preventDefault(); void onSubmit(new FormData(event.currentTarget)); }}><div className="source-composer__heading"><strong>{t("admin.sources.new_source")} · {ecosystem.toUpperCase()}</strong><small>{t("admin.sources.checksum_locked")}</small></div><div className="source-form-grid"><label>{t("admin.sources.key")}<input name="sourceKey" required placeholder={`${ecosystem}.team.cache`} /></label><label>{t("admin.sources.display_name")}<input name="displayName" required /></label><label>{t("admin.sources.kind")}<select name="kind" defaultValue="proxy-cache"><option value="hosted">{t("presentation.label_21")}</option><option value="proxy-cache">{t("presentation.label_22")}</option><option value="upstream">{t("presentation.label_23")}</option><option value="mirror">{t("presentation.label_24")}</option><option value="offline-media">{t("presentation.label_25")}</option></select></label><label>{t("admin.sources.zone")}<select name="networkZone" defaultValue="internal"><option value="internal">{t("presentation.label_26")}</option><option value="lan">{t("presentation.label_27")}</option><option value="internet">{t("presentation.label_28")}</option></select></label><label className="source-form-wide">URL<input name="url" type="url" required defaultValue={`http://source-gateway.internal/${ecosystem}/`} /></label><label>{t("admin.sources.priority")}<input name="priority" type="number" min="0" max="10000" defaultValue="100" /></label><label>{t("admin.sources.scopes")}<input name="packageScopes" required defaultValue="*" /></label><label>{t("admin.sources.architectures")}<input name="architectures" required defaultValue={ecosystem === "npm" ? "all" : "arm64,source"} /></label><label>{t("admin.sources.signature")}<select name="signaturePolicy" defaultValue="preferred"><option value="required">{t("presentation.label_29")}</option><option value="preferred">{t("presentation.label_30")}</option><option value="not-available">{t("presentation.label_31")}</option></select></label><label>{t("admin.sources.online_mode")}<select name="onlineMode" defaultValue="auto"><option value="auto">{t("presentation.label_32")}</option><option value="online">{t("presentation.label_33")}</option><option value="offline">{t("presentation.label_34")}</option></select></label><label>{t("admin.sources.cache_mode")}<select name="cacheMode" defaultValue="read-through"><option value="none">{t("presentation.label_35")}</option><option value="read-through">{t("presentation.label_36")}</option><option value="hosted">{t("presentation.label_21")}</option><option value="immutable-offline">{t("presentation.label_37")}</option></select></label><label>{t("admin.sources.cache_bytes")}<input name="maximumBytes" type="number" min="0" defaultValue="10737418240" /></label><label>{t("admin.sources.ttl")}<input name="ttlSeconds" type="number" min="0" defaultValue="3600" /></label><label>{t("admin.sources.secret_key")}<input name="credentialSecretKey" placeholder={`source.${ecosystem}.…`} /></label><label className="source-form-wide">{t("admin.sources.storage_pool")}<input name="storagePoolId" placeholder={t("admin.sources.offline_only")} /></label></div><button className="primary-button" disabled={saving} type="submit">{saving ? <LoaderCircle className="auth-spinner" size={14} /> : <PackagePlus size={14} />}{t("admin.sources.save")}</button></form>;
}

function PolicyForm({ saving, t, onSubmit }: { saving: boolean; t: (key: string) => string; onSubmit: (form: FormData) => void }) {
  return <form className="policy-composer" onSubmit={(event) => { event.preventDefault(); void onSubmit(new FormData(event.currentTarget)); }}><label>{t("admin.sources.policy_key")}<input name="policyKey" required /></label><label>{t("admin.sources.display_name")}<input name="displayName" required /></label><label>{t("admin.sources.environment")}<select name="environment"><option value="agent">{t("presentation.label_38")}</option><option value="application-build">{t("presentation.label_39")}</option><option value="model-build">{t("presentation.label_40")}</option></select></label><label>{t("admin.sources.architectures")}<select name="architecture"><option value="arm64">arm64</option><option value="amd64">amd64</option><option value="all">{t("presentation.label_41")}</option><option value="source">{t("presentation.label_42")}</option></select></label><label>{t("admin.sources.offline_policy")}<select name="offlineMode"><option value="allow-online">{t("presentation.label_43")}</option><option value="prefer-offline">{t("presentation.label_44")}</option><option value="require-offline">{t("presentation.label_45")}</option></select></label><label>{t("admin.sources.team_key")}<input name="teamKey" /></label><label>{t("admin.sources.sandbox_key")}<input name="sandboxProfileKey" /></label><button type="submit" disabled={saving}>{t("admin.sources.save_policy")}</button></form>;
}

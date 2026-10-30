import { Activity, AlertTriangle, Box, Check, CloudCog, Cpu, Download, Gauge, HardDrive, Layers3, ListTree, LoaderCircle, MemoryStick, Network, RefreshCw, Search, ShieldCheck, Thermometer, Unplug, Workflow, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { exportOperationalDiagnostics, loadOperationalDiagnostics, loadApplianceDashboard, lookupOperationalCorrelation, runOperationalRetention, type CorrelationLookup, type DashboardMetric, type DeviceMetricView, type OperationalAlert, type OperationalHealth, type OperationsDashboard } from "./appliance-client";

function bytes(value = 0) { if (value >= 1024 ** 4) return `${(value / 1024 ** 4).toFixed(1)} TiB`; if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GiB`; return `${(value / 1024 ** 2).toFixed(0)} MiB`; }

export function AppliancePanel({ permissions, t }: { permissions: readonly string[]; t: (key: string) => string }) {
  const [dashboard, setDashboard] = useState<OperationsDashboard | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(false);
  const load = useCallback(async () => {
    setLoading(true); setError(false);
    try { setDashboard(await loadApplianceDashboard()); } catch { setError(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void load(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [load]);
  if (loading && !dashboard) return <div className="appliance-state" role="status" aria-live="polite" aria-busy="true"><LoaderCircle className="auth-spinner" size={23} aria-hidden="true" />{t("admin.device.loading")}</div>;
  return <section className="appliance-panel" aria-label={t("admin.device.workspace")}>
    <header className="appliance-header"><div><h2>{t("admin.device.workspace")}</h2><p>{t("admin.device.workspace_description")}</p></div><button type="button" className="secondary-button" onClick={() => void load()} disabled={loading}><RefreshCw size={14} />{t("admin.device.refresh")}</button></header>
    {error && <div className="appliance-error" role="alert"><AlertTriangle size={16} />{t("admin.device.error")}</div>}
    <OperationsOverview dashboard={dashboard} t={t} />
    {permissions.includes("operations:view") && <OperationsDiagnosticsPanel canManage={permissions.includes("operations:manage")} canViewSensitive={permissions.includes("diagnostic_sensitive:view")} t={t} />}
  </section>;
}

function metricStatus(metric?: DashboardMetric | null) { return metric?.effectiveStatus ?? metric?.status ?? "unavailable"; }
function metricText(metric: DashboardMetric | undefined, formatter: (value: number) => string) { return metric?.value !== null && metric?.value !== undefined && new Set(["measured", "partial", "configured"]).has(metricStatus(metric)) ? formatter(metric.value) : "—"; }
function percent(value: number) { return `${value.toFixed(0)}%`; }
function rate(value: number) { return value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GiB/s` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB/s` : `${(value / 1024).toFixed(0)} KiB/s`; }
function bits(value: number) { return value >= 1e9 ? `${(value / 1e9).toFixed(1)} Gbps` : value >= 1e6 ? `${(value / 1e6).toFixed(0)} Mbps` : `${(value / 1e3).toFixed(0)} Kbps`; }
function StatusChip({ status, t }: { status: string; t: (key: string) => string }) { return <span className={`metric-status metric-status--${status}`}>{t(`admin.operations.status.${status}`)}</span>; }

function MetricCard({ icon: Icon, label, metric, formatter, t }: { icon: typeof Gauge; label: string; metric?: DashboardMetric; formatter: (value: number) => string; t: (key: string) => string }) {
  const status = metricStatus(metric);
  return <article className={`operations-metric operations-metric--${status}`} title={metric?.reasonCode ?? undefined}><span><Icon size={16} /></span><div><small>{label}</small><strong>{metricText(metric, formatter)}</strong></div><StatusChip status={status} t={t} /></article>;
}

const JOB_KEYS = ["queued", "preparing", "running", "succeeded", "failed", "cancelled"] as const;

function MetricMapGroup({ icon, title, values, rows, t }: { icon: typeof Activity; title: string; values: Readonly<Record<string, DashboardMetric>>; rows: readonly (readonly [string, string, (value: number) => string])[]; t: (key: string) => string }) {
  return <TelemetryGroup icon={icon} title={title} empty={rows.length === 0} t={t}>{rows.map(([key, label, formatter]) => { const metric = values[key]; return <TelemetryRow key={key} primary={t(label)} secondary={metric?.reasonCode ?? t("admin.operations.current_value")} metric={metricText(metric, formatter)} status={metricStatus(metric)} t={t} />; })}</TelemetryGroup>;
}

export function OperationsOverview({ dashboard, t }: { dashboard: OperationsDashboard | null; t: (key: string) => string }) {
  const [overviewAlertsShown, setOverviewAlertsShown] = useState(12);
  if (!dashboard) return <section className="operations-unavailable"><Activity size={18} /><div><strong>{t("admin.operations.unavailable")}</strong><p>{t("admin.operations.unavailable_detail")}</p></div><StatusChip status="unavailable" t={t} /></section>;
  const domains = dashboard.appliance.metrics?.domains ?? {};
  return <section className="operations-dashboard" aria-label={t("admin.operations.title")}>
    <header><div><p className="eyebrow">{t("presentation.label_0")}</p><h3>{t("admin.operations.title")}</h3><p>{t("admin.operations.description")}</p></div><div className="operations-freshness"><StatusChip status={dashboard.appliance.collectionStatus} t={t} /><small>{t("admin.operations.updated")} {new Date(dashboard.generatedAt).toLocaleTimeString()}</small></div></header>
    <div className="operations-metrics-grid">
      <MetricCard icon={Cpu} label={t("admin.operations.cpu")} metric={domains.cpu?.utilizationPercent} formatter={percent} t={t} />
      <MetricCard icon={MemoryStick} label={t("admin.operations.memory_used")} metric={domains.unifiedMemory?.usedBytes} formatter={bytes} t={t} />
      <MetricCard icon={Gauge} label={t("admin.operations.accelerator")} metric={domains.accelerator?.utilizationPercent} formatter={percent} t={t} />
      <MetricCard icon={Thermometer} label={t("admin.operations.temperature")} metric={domains.accelerator?.temperatureCelsius} formatter={(value) => `${value.toFixed(0)}°C`} t={t} />
      <MetricCard icon={Zap} label={t("admin.operations.power")} metric={domains.accelerator?.powerWatts} formatter={(value) => `${value.toFixed(0)} W`} t={t} />
      <MetricCard icon={HardDrive} label={t("admin.operations.storage_free")} metric={domains.storage?.availableBytes} formatter={bytes} t={t} />
      <MetricCard icon={Network} label={t("admin.operations.network_rx")} metric={domains.network?.receiveBytesPerSecond} formatter={rate} t={t} />
      <MetricCard icon={Box} label={t("admin.operations.codec")} metric={domains.codecs?.encodeActive} formatter={(value) => String(value)} t={t} />
    </div>
    <section className="operations-alerts"><header><AlertTriangle size={15} /><strong>{t("admin.operations.alerts")}</strong><span>{dashboard.alerts.length}</span></header>{dashboard.alerts.length === 0 ? <p>{t("admin.operations.no_alerts")}</p> : <div>{dashboard.alerts.slice(0, overviewAlertsShown).map((item) => <article key={item.alertId} className={`severity-${item.severity}`}><AlertTriangle size={13} /><div><strong>{t(item.titleKey)}</strong><small>{t(item.detailKey)}</small></div><em>{item.scope.kind}</em></article>)}</div>}{overviewAlertsShown < dashboard.alerts.length && <button type="button" onClick={() => setOverviewAlertsShown((n) => n + 12)}>{t("admin.diagnostics.more")}</button>}</section>
    <section className="operations-detail"><DeviceTelemetryDetail value={dashboard.appliance.metrics} t={t} /></section>
    <ExternalProviders value={dashboard.externalProviders} t={t} />
  </section>;
}

function DeviceTelemetryDetail({ value, t }: { value: DeviceMetricView | null; t: (key: string) => string }) {
  if (!value) return <div className="device-telemetry-empty"><Unplug size={18} /><div><strong>{t("admin.operations.no_metrics")}</strong><p>{t("admin.operations.no_metrics_detail")}</p></div><StatusChip status="missing" t={t} /></div>;
  const domains = value.domains;
  return <div className="device-telemetry-detail">
    <div className="device-telemetry-columns">
      <TelemetryGroup icon={Workflow} title={t("admin.operations.workers_models")} empty={value.workers.length + value.models.length === 0} t={t}>{value.workers.map((worker) => <TelemetryRow key={worker.workerId} primary={worker.workerId.slice(0, 12)} secondary={`${worker.state} · ${worker.jobId ? `${t("admin.operations.job_id")} ${worker.jobId.slice(0, 8)}` : t("admin.operations.no_active_job")} · ${worker.profileId?.slice(0, 8) ?? "—"}`} metric={metricText(worker.unifiedMemoryBytes, bytes)} status={metricStatus(worker.unifiedMemoryBytes)} t={t} />)}{value.models.map((model) => <TelemetryRow key={model.profileId} primary={model.profileId.slice(0, 12)} secondary={`${model.state} · ${t("admin.operations.model")} · ${t("admin.operations.load_time")} ${metricText(model.loadMilliseconds, (number) => `${number.toFixed(0)} ms`)}`} metric={metricText(model.unifiedMemoryBytes, bytes)} status={metricStatus(model.unifiedMemoryBytes)} t={t} />)}</TelemetryGroup>
      <TelemetryGroup icon={ListTree} title={t("admin.operations.queues")} empty={value.queues.length === 0} t={t}>{value.queues.map((queue) => <TelemetryRow key={queue.queueKey} primary={queue.queueKey} secondary={queue.reasons.map((reason) => `${reason.reasonCode} ×${reason.count}`).join(" · ") || t("admin.operations.no_wait_reason")} metric={metricText(queue.depth, (number) => String(number))} status={metricStatus(queue.depth)} t={t} />)}</TelemetryGroup>
      <TelemetryGroup icon={Activity} title={t("admin.operations.process_attribution")} empty={value.processes.length === 0} t={t}>{value.processes.map((process) => <TelemetryRow key={`${process.targetKind}:${process.targetId}`} primary={process.targetId.slice(0, 16)} secondary={process.targetKind} metric={metricText(process.unifiedMemoryBytes, bytes)} status={metricStatus(process.unifiedMemoryBytes)} t={t} />)}</TelemetryGroup>
      <TelemetryGroup icon={ShieldCheck} title={t("admin.operations.core_services")} empty={value.coreServices.length === 0} t={t}>{value.coreServices.map((service) => <TelemetryRow key={service.serviceKey} primary={service.serviceKey} secondary={service.state} metric={metricText(service.latencyMilliseconds, (number) => `${number.toFixed(0)} ms`)} status={metricStatus(service.latencyMilliseconds)} t={t} />)}</TelemetryGroup>
      <MetricMapGroup icon={Workflow} title={t("admin.operations.job_states")} values={value.jobs} rows={JOB_KEYS.map((key) => [key, `admin.operations.job.${key}`, (number: number) => String(number)] as const)} t={t} />
      <TelemetryGroup icon={Layers3} title={t("admin.operations.resource_evidence")} empty={false} t={t}>
        <TelemetryRow primary={t("admin.operations.dedicated_accelerator_memory")} secondary={domains.unifiedMemory?.dedicatedAcceleratorMemoryBytes?.reasonCode ?? t("admin.operations.current_value")} metric={metricText(domains.unifiedMemory?.dedicatedAcceleratorMemoryBytes, bytes)} status={metricStatus(domains.unifiedMemory?.dedicatedAcceleratorMemoryBytes)} t={t} />
        <TelemetryRow primary={t("admin.operations.storage_read")} secondary={domains.storage?.readBytesPerSecond?.reasonCode ?? t("admin.operations.current_value")} metric={metricText(domains.storage?.readBytesPerSecond, rate)} status={metricStatus(domains.storage?.readBytesPerSecond)} t={t} />
        <TelemetryRow primary={t("admin.operations.storage_write")} secondary={domains.storage?.writeBytesPerSecond?.reasonCode ?? t("admin.operations.current_value")} metric={metricText(domains.storage?.writeBytesPerSecond, rate)} status={metricStatus(domains.storage?.writeBytesPerSecond)} t={t} />
        <TelemetryRow primary={t("admin.operations.network_tx")} secondary={domains.network?.transmitBytesPerSecond?.reasonCode ?? t("admin.operations.current_value")} metric={metricText(domains.network?.transmitBytesPerSecond, rate)} status={metricStatus(domains.network?.transmitBytesPerSecond)} t={t} />
        <TelemetryRow primary={t("admin.operations.network_capacity")} secondary={domains.network?.availableBitsPerSecond?.reasonCode ?? t("admin.operations.current_value")} metric={metricText(domains.network?.availableBitsPerSecond, bits)} status={metricStatus(domains.network?.availableBitsPerSecond)} t={t} />
        <TelemetryRow primary={t("admin.operations.codec_capacity")} secondary={domains.codecs?.encodeCapacity?.reasonCode ?? t("admin.operations.current_value")} metric={metricText(domains.codecs?.encodeCapacity, (number) => String(number))} status={metricStatus(domains.codecs?.encodeCapacity)} t={t} />
      </TelemetryGroup>
    </div>
    <footer><span>{t("admin.operations.observed_at")} {new Date(value.observedAt).toLocaleString()}</span><span>seq {value.sequence}</span><StatusChip status={value.freshness.status} t={t} /></footer>
  </div>;
}

function TelemetryGroup({ icon: Icon, title, empty, children, t }: { icon: typeof Activity; title: string; empty: boolean; children: React.ReactNode; t: (key: string) => string }) { return <section className="telemetry-group"><header><Icon size={14} /><strong>{title}</strong></header>{empty ? <p>{t("admin.operations.no_data")}</p> : <div>{children}</div>}</section>; }
function TelemetryRow({ primary, secondary, metric, status, t }: { primary: string; secondary: string; metric: string; status: string; t: (key: string) => string }) { return <article><div><strong>{primary}</strong><small>{secondary}</small></div><b>{metric}</b><StatusChip status={status} t={t} /></article>; }

function ExternalProviders({ value, t }: { value: OperationsDashboard["externalProviders"]; t: (key: string) => string }) { return <section className="external-metrics"><header><CloudCog size={15} /><div><strong>{t("admin.operations.external")}</strong><small>{t("admin.operations.external_detail")}</small></div><StatusChip status={value.status === "available" ? "fresh" : "unavailable"} t={t} /></header>{value.data.length === 0 ? <p>{t("admin.operations.no_external")}</p> : <div>{value.data.map((provider) => <article key={provider.providerId}><header><div><strong>{provider.displayName}</strong><small>{provider.providerKey} · {provider.lifecycleState}</small></div><StatusChip status={provider.freshness.status} t={t} /></header><div><MetricCard icon={Activity} label={t("admin.operations.provider_latency")} metric={provider.health.latencyMilliseconds} formatter={(number) => `${number.toFixed(0)} ms`} t={t} /><MetricCard icon={Workflow} label={t("admin.operations.provider_concurrency")} metric={provider.metrics.concurrencyLimit} formatter={(number) => String(number)} t={t} /><MetricCard icon={Gauge} label={t("admin.operations.provider_accelerator")} metric={provider.metrics.accelerator} formatter={percent} t={t} /></div></article>)}</div>}</section>; }

function downloadBundle(bundle: Awaited<ReturnType<typeof exportOperationalDiagnostics>>) {
  const url = URL.createObjectURL(bundle.blob);
  const link = document.createElement("a"); link.href = url; link.download = bundle.filename; link.hidden = true; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 0);
}

function healthStatus(value: OperationalHealth["state"]) { return value === "healthy" ? "fresh" : value === "unknown" ? "missing" : value === "degraded" ? "partial" : "unavailable"; }

function OperationsDiagnosticsPanel({ canManage, canViewSensitive, t }: { canManage: boolean; canViewSensitive: boolean; t: (key: string, values?: Record<string, string | number>) => string }) {
  const [health, setHealth] = useState<OperationalHealth[]>([]), [alerts, setAlerts] = useState<OperationalAlert[]>([]), [lookup, setLookup] = useState<CorrelationLookup | null>(null);
  const [healthShown, setHealthShown] = useState(12), [alertsShown, setAlertsShown] = useState(12), [signalsShown, setSignalsShown] = useState(12);
  const [correlationId, setCorrelationId] = useState(""), [includeSensitive, setIncludeSensitive] = useState(false), [reason, setReason] = useState("");
  const [loading, setLoading] = useState(true), [working, setWorking] = useState(false), [failed, setFailed] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const refresh = async () => { setLoading(true); setFailed(false); try { const value = await loadOperationalDiagnostics(); setHealth(value.health); setAlerts(value.alerts); } catch { setFailed(true); } finally { setLoading(false); } };
  useEffect(() => { void refresh(); }, []);
  const inspect = async (event: React.FormEvent) => { event.preventDefault(); if (!correlationId.trim()) return; setWorking(true); setFailed(false); setNotice(null); try { setSignalsShown(12); setLookup(await lookupOperationalCorrelation(correlationId.trim())); } catch { setFailed(true); } finally { setWorking(false); } };
  const exportBundle = async () => { setWorking(true); setFailed(false); setNotice(null); try { const bundle = await exportOperationalDiagnostics({ ...(correlationId.trim() ? { correlationId: correlationId.trim() } : {}), ...(includeSensitive ? { includeSensitive: true, reason: reason.trim() } : {}) }); downloadBundle(bundle); setNotice(t("admin.diagnostics.export_ready")); } catch { setFailed(true); } finally { setWorking(false); } };
  const retain = async () => { setWorking(true); setFailed(false); setNotice(null); try { const result = await runOperationalRetention(); setNotice(t("admin.diagnostics.retention_complete", { count: Object.values(result.deleted).reduce((sum, value) => sum + value, 0) })); await refresh(); } catch { setFailed(true); } finally { setWorking(false); } };
  return <section className="operations-diagnostics" aria-label={t("admin.diagnostics.title")}>
    <header><Activity size={16} /><div><strong>{t("admin.diagnostics.title")}</strong><small>{t("admin.diagnostics.description")}</small></div><button type="button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={13} />{t("admin.device.refresh")}</button></header>
    {failed && <p className="diagnostics-error" role="alert"><AlertTriangle size={13} />{t("admin.diagnostics.error")}</p>}
    {notice && <p className="diagnostics-notice" role="status"><Check size={13} />{notice}</p>}
    <div className="diagnostics-health"><section><header><strong>{t("admin.diagnostics.health")}</strong><span>{health.length}</span></header>{loading ? <p>{t("admin.device.loading")}</p> : health.length === 0 ? <p>{t("admin.diagnostics.no_health")}</p> : <div>{health.slice(0, healthShown).map((item) => <article key={`${item.target.kind}:${item.target.key}`}><i className={`health-dot health-dot--${item.state}`} /><div><strong>{item.target.key}</strong><small>{item.target.kind} · {item.reasonCode ?? t("admin.diagnostics.healthy")}</small></div><StatusChip status={healthStatus(item.state)} t={t} /></article>)}</div>}{healthShown < health.length && <button type="button" onClick={() => setHealthShown((n) => n + 12)}>{t("admin.diagnostics.more")}</button>}</section>
      <section><header><strong>{t("admin.diagnostics.persistent_alerts")}</strong><span>{alerts.length}</span></header>{alerts.length === 0 ? <p>{t("admin.diagnostics.no_alerts")}</p> : <div>{alerts.slice(0, alertsShown).map((item) => <article key={item.alertId}><AlertTriangle className={`alert-icon--${item.severity}`} size={13} /><div><strong>{t(item.titleKey)}</strong><small>{item.target.kind} · {item.jobIds.length} {t("admin.diagnostics.jobs")} · ×{item.occurrenceCount}</small></div><button type="button" title={item.correlationId} onClick={() => setCorrelationId(item.correlationId)}>{item.correlationId.slice(0, 12)}</button></article>)}</div>}{alertsShown < alerts.length && <button type="button" onClick={() => setAlertsShown((n) => n + 12)}>{t("admin.diagnostics.more")}</button>}</section></div>
    <form className="diagnostics-correlation" onSubmit={inspect}><label><span>{t("admin.diagnostics.correlation")}</span><input value={correlationId} onChange={(event) => setCorrelationId(event.target.value)} minLength={8} maxLength={128} pattern="[A-Za-z0-9][A-Za-z0-9._:-]{7,127}" placeholder="request-…" /></label><button type="submit" disabled={working || correlationId.trim().length < 8}><Search size={13} />{t("admin.diagnostics.lookup")}</button><button type="button" disabled={working || (includeSensitive && reason.trim().length < 8)} onClick={() => void exportBundle()}><Download size={13} />{t("admin.diagnostics.export")}</button>{canManage && <button type="button" disabled={working} onClick={() => void retain()}>{t("admin.diagnostics.retention")}</button>}</form>
    {canViewSensitive && <div className="diagnostics-sensitive"><label><input type="checkbox" checked={includeSensitive} onChange={(event) => setIncludeSensitive(event.target.checked)} />{t("admin.diagnostics.include_sensitive")}</label>{includeSensitive && <input value={reason} onChange={(event) => setReason(event.target.value)} minLength={8} maxLength={256} placeholder={t("admin.diagnostics.reason")} />}</div>}
    {lookup && <section className="diagnostics-lookup"><header><strong>{t("admin.diagnostics.lookup_result")}</strong><code>{lookup.correlationId}</code></header><div><span>{lookup.signals.length}<small>{t("admin.diagnostics.signals")}</small></span><span>{lookup.health.length}<small>{t("admin.diagnostics.health")}</small></span><span>{lookup.alerts.length}<small>{t("admin.operations.alerts")}</small></span></div>{lookup.signals.length === 0 ? <p>{t("admin.diagnostics.no_result")}</p> : <ol>{lookup.signals.slice(0, signalsShown).map((item) => <li key={item.signalId}><code>{item.eventKey}</code><span>{item.producer.kind}/{item.producer.key.slice(0, 18)}</span><time>{new Date(item.observedAt).toLocaleString()}</time></li>)}</ol>}{signalsShown < lookup.signals.length && <button type="button" onClick={() => setSignalsShown((n) => n + 12)}>{t("admin.diagnostics.more")}</button>}</section>}
  </section>;
}

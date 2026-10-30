import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CloudCog,
  KeyRound,
  LoaderCircle,
  Play,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  WifiOff,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { InlineEditor } from "../InlineEditor";

import {
  createExternalProvider,
  createRoutingPolicy,
  listExternalProviders,
  listRoutingPolicies,
  removeExternalProvider,
  rotateExternalProviderCredential,
  setExternalProviderEnabled,
  testExternalProvider,
  updateRoutingPolicy,
  type ExternalProvider,
  type RoutingPolicy,
} from "./external-provider-client";

type Translate = (key: string, values?: Record<string, string | number>) => string;

function integer(form: FormData, key: string) { return Number(form.get(key)); }
function list(form: FormData, key: string) { return String(form.get(key) ?? "").split(",").map((value) => value.trim()).filter(Boolean); }
function targetWeights(form: FormData) {
  return Object.fromEntries(list(form, "targetWeights").map((entry) => {
    const separator = entry.lastIndexOf("=");
    return [entry.slice(0, separator).trim(), Number(entry.slice(separator + 1))];
  }).filter(([key, value]) => key && Number.isInteger(value)));
}

function declaration(form: FormData) {
  const authScheme = String(form.get("authScheme"));
  const trustMode = String(form.get("trustMode"));
  const maximumOutputTokens = integer(form, "maximumOutputTokens");
  return {
    providerKey: String(form.get("providerKey")),
    displayName: String(form.get("displayName")),
    endpoint: String(form.get("endpoint")),
    auth: { scheme: authScheme, ...(authScheme === "api_key_header" ? { headerName: String(form.get("headerName")) } : {}) },
    credential: authScheme === "none" ? null : String(form.get("credential")),
    trust: { mode: trustMode, serverName: String(form.get("serverName")) || null },
    customCaPem: trustMode === "custom_ca" ? String(form.get("customCaPem")) : null,
    allowedDataClasses: list(form, "allowedDataClasses"),
    limits: { concurrency: integer(form, "concurrency"), requestsPerMinute: integer(form, "requestsPerMinute"), tokensPerMinute: null },
    timeouts: { connectMilliseconds: integer(form, "connectMilliseconds"), requestMilliseconds: integer(form, "requestMilliseconds"), idleStreamMilliseconds: integer(form, "idleStreamMilliseconds") },
    modelMappings: [{
      modelProfileId: String(form.get("modelProfileId")),
      providerModelName: String(form.get("providerModelName")),
      operations: list(form, "operations"),
      contextWindow: integer(form, "contextWindow"),
      maximumOutputTokens: maximumOutputTokens > 0 ? maximumOutputTokens : null,
      routingWeight: integer(form, "routingWeight"),
      enabled: true,
    }],
    costAccounting: {
      currency: String(form.get("currency")), accountingMode: String(form.get("accountingMode")),
      inputMicrounitsPerMillionTokens: 0, outputMicrounitsPerMillionTokens: 0,
      imageMicrounitsPerRequest: 0, audioMicrounitsPerMinute: 0,
    },
  };
}

function routingDeclaration(form: FormData) {
  const mode = String(form.get("routingMode"));
  const pinnedTargetId = String(form.get("pinnedTargetId") ?? "").trim() || null;
  const pinnedProfileId = String(form.get("pinnedProfileId") ?? "").trim() || null;
  return {
    policyKey: String(form.get("policyKey")), displayName: String(form.get("displayName")),
    selector: {
      capabilityId: String(form.get("capabilityId") ?? "").trim() || null,
      operation: String(form.get("operation") ?? "").trim() || null,
      teamId: null, dataClasses: list(form, "dataClasses"),
    },
    priority: integer(form, "priority"), enabled: true,
    routing: {
      mode, externalProcessingApproved: form.get("externalProcessingApproved") === "on",
      ...(mode === "pinned" ? { pinnedTargetId, pinnedProfileId } : {}),
      ...(mode === "weighted" ? { targetWeights: targetWeights(form) } : {}),
    },
  };
}

export function ExternalProvidersPanel({ canManage, t }: { canManage: boolean; t: Translate }) {
  const [providers, setProviders] = useState<ExternalProvider[]>([]);
  const [policies, setPolicies] = useState<RoutingPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [composer, setComposer] = useState(false);
  const [policyComposer, setPolicyComposer] = useState(false);

  const load = async () => {
    setError(null);
    try { const [nextProviders, nextPolicies] = await Promise.all([listExternalProviders(), listRoutingPolicies()]); setProviders(nextProviders); setPolicies(nextPolicies); }
    catch (failure: any) { setError(failure?.code ?? "request_failed"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const summary = useMemo(() => ({
    healthy: providers.filter((item) => item.lifecycleState === "healthy" && item.health.state === "healthy").length,
    contracted: providers.filter((item) => item.contract.state === "passed").length,
    models: providers.reduce((total, item) => total + item.modelMappings.filter((mapping) => mapping.enabled).length, 0),
  }), [providers]);

  const mutate = async (operation: () => Promise<unknown>) => {
    setSaving(true); setError(null);
    try { await operation(); await load(); }
    catch (failure: any) { setError(failure?.code ?? "request_failed"); }
    finally { setSaving(false); }
  };

  const submit = async (form: FormData) => {
    await mutate(async () => { await createExternalProvider(declaration(form)); setComposer(false); });
  };
  const submitPolicy = async (form: FormData) => {
    await mutate(async () => { await createRoutingPolicy(routingDeclaration(form)); setPolicyComposer(false); });
  };

  if (loading) return <div className="provider-state" role="status" aria-live="polite" aria-busy="true"><LoaderCircle className="auth-spinner" size={23} aria-hidden="true" />{t("admin.providers.loading")}</div>;
  return (
    <section className="provider-center" aria-label={t("admin.providers.workspace")}>
      <header className="provider-center__header">
        <div><p className="eyebrow">{t("presentation.label_3")}</p><h2>{t("admin.providers.workspace")}</h2><p>{t("admin.providers.workspace_description")}</p></div>
        <div><button type="button" className="secondary-button" disabled={saving} onClick={() => void load()}><RefreshCw size={14} />{t("admin.providers.refresh")}</button>{canManage && <button type="button" className="primary-button" onClick={() => setComposer((value) => !value)}><Plus size={14} />{t("admin.providers.add")}</button>}</div>
      </header>
      {error && <div className="provider-error" role="alert"><AlertTriangle size={16} />{t("admin.providers.error")}<code>{error}</code></div>}
      <div className="provider-summary">
        <article><CloudCog size={18} /><span><strong>{providers.length}</strong>{t("admin.providers.total")}</span></article>
        <article><Activity size={18} /><span><strong>{summary.healthy}</strong>{t("admin.providers.healthy")}</span></article>
        <article><ShieldCheck size={18} /><span><strong>{summary.contracted}</strong>{t("admin.providers.contracted")}</span></article>
        <article><Play size={18} /><span><strong>{summary.models}</strong>{t("admin.providers.models")}</span></article>
      </div>
      {composer && <InlineEditor title={t("admin.providers.add")} feedback={error && t("admin.providers.error")} busy={saving} cancelLabel={t("common.cancel")} onCancel={() => setComposer(false)}><ProviderForm saving={saving} t={t} onSubmit={submit} /></InlineEditor>}
      {providers.length === 0 ? <div className="provider-empty"><CloudCog size={28} /><p>{t("admin.providers.empty")}</p></div> : <div className="provider-grid">{providers.map((provider) => <ProviderCard key={provider.providerId} provider={provider} canManage={canManage} saving={saving} t={t} mutate={mutate} />)}</div>}
      <p className="provider-metric-boundary"><AlertTriangle size={13} />{t("admin.providers.metric_boundary")}</p>
      <section className="routing-policy-center" aria-label={t("admin.providers.routing_title")}>
        <header><div><h3>{t("admin.providers.routing_title")}</h3><p>{t("admin.providers.routing_description")}</p></div>{canManage && <button type="button" className="secondary-button" disabled={saving} onClick={() => setPolicyComposer((value) => !value)}><Plus size={13} />{t("admin.providers.routing_add")}</button>}</header>
        {policyComposer && <InlineEditor title={t("admin.providers.routing_add")} feedback={error && t("admin.providers.error")} busy={saving} cancelLabel={t("common.cancel")} onCancel={() => setPolicyComposer(false)}><RoutingPolicyForm saving={saving} providers={providers} t={t} onSubmit={submitPolicy} /></InlineEditor>}
        {policies.length === 0 ? <div className="provider-empty"><ShieldCheck size={24} /><p>{t("admin.providers.routing_empty")}</p></div> : <div className="routing-policy-grid">{policies.map((policy) => <article key={policy.policyId}><header><div><strong>{policy.displayName}</strong><code>{policy.policyKey}</code></div><em>{t(`admin.providers.routing_mode.${policy.routing.mode}`)}</em></header><p>{policy.selector.operation ?? t("admin.providers.routing_any_operation")} · {policy.selector.dataClasses.length ? policy.selector.dataClasses.join(" · ") : t("admin.providers.routing_any_data")}</p><small>{policy.routing.externalProcessingApproved ? t("admin.providers.routing_external_approved") : t("admin.providers.routing_external_denied")} · P{policy.priority}</small>{canManage && <button type="button" disabled={saving} onClick={() => void mutate(() => updateRoutingPolicy(policy, { enabled: !policy.enabled }))}>{t(policy.enabled ? "admin.providers.routing_disable" : "admin.providers.routing_enable")}</button>}</article>)}</div>}
      </section>
    </section>
  );
}

function RoutingPolicyForm({ saving, providers, t, onSubmit }: { saving: boolean; providers: ExternalProvider[]; t: Translate; onSubmit: (form: FormData) => Promise<void> }) {
  return <form className="provider-composer" onSubmit={(event) => { event.preventDefault(); void onSubmit(new FormData(event.currentTarget)); }}>
    <div className="provider-composer__heading"><strong>{t("admin.providers.routing_new")}</strong><small>{t("admin.providers.routing_new_detail")}</small></div>
    <div className="provider-form-grid">
      <label>{t("admin.providers.routing_key")}<input name="policyKey" required pattern="[a-z][a-z0-9_.-]{2,127}" placeholder="team.default" /></label>
      <label>{t("admin.providers.display_name")}<input name="displayName" required /></label>
      <label>{t("admin.providers.routing_mode")}<select name="routingMode" defaultValue="internal_first"><option value="internal_only">{t("presentation.label_7")}</option><option value="internal_first">{t("presentation.label_8")}</option><option value="external_first">{t("presentation.label_9")}</option><option value="weighted">{t("presentation.label_10")}</option><option value="pinned">{t("presentation.label_11")}</option></select></label>
      <label>{t("admin.providers.routing_priority")}<input name="priority" type="number" min="0" max="10000" defaultValue="100" required /></label>
      <label>{t("admin.providers.routing_operation")}<input name="operation" placeholder="responses" /></label>
      <label>{t("admin.providers.routing_data_classes")}<input name="dataClasses" defaultValue="internal" /></label>
      <label>{t("admin.providers.routing_capability")}<input name="capabilityId" pattern="[0-9a-fA-F-]{36}" /></label>
      <label>{t("admin.providers.routing_pinned_target")}<input name="pinnedTargetId" list="external-provider-targets" /><datalist id="external-provider-targets">{providers.map((provider) => <option key={provider.providerId} value={provider.providerId}>{provider.displayName}</option>)}</datalist></label>
      <label>{t("admin.providers.routing_pinned_profile")}<input name="pinnedProfileId" /></label>
      <label className="provider-form-wide">{t("admin.providers.routing_weights")}<input name="targetWeights" placeholder="spark-local=100, provider-id=200" /></label>
      <label className="provider-checkbox"><input name="externalProcessingApproved" type="checkbox" />{t("admin.providers.routing_external_consent")}</label>
    </div>
    <button type="submit" className="primary-button" disabled={saving}><Plus size={14} />{t("admin.providers.save")}</button>
  </form>;
}

function ProviderCard({ provider, canManage, saving, t, mutate }: { provider: ExternalProvider; canManage: boolean; saving: boolean; t: Translate; mutate: (operation: () => Promise<unknown>) => Promise<void> }) {
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const healthy = provider.health.state === "healthy";
  const HealthIcon = healthy ? CheckCircle2 : provider.health.state === "unknown" ? Activity : WifiOff;
  return <article className={`provider-card provider-card--${provider.lifecycleState}`}>
    <header><span className={`provider-health provider-health--${provider.health.state}`}><HealthIcon size={16} /></span><div><strong>{provider.displayName}</strong><code>{provider.providerKey}</code></div><em>{provider.lifecycleState}</em></header>
    <a href={provider.endpoint} target="_blank" rel="noreferrer">{provider.endpoint}</a>
    <div className="provider-facts"><span>{provider.auth.scheme}</span><span>{provider.trust.mode}</span><span>{provider.allowedDataClasses.join(" · ")}</span><span>{provider.limits.concurrency}×</span><span>{provider.health.latencyMilliseconds === null ? "— ms" : `${provider.health.latencyMilliseconds} ms`}</span></div>
    <div className="provider-contract"><ShieldCheck size={14} /><div><strong>{t(`admin.providers.contract.${provider.contract.state}`)}</strong><small>{provider.contract.evidenceDigest ? `${provider.contract.evidenceDigest.slice(0, 23)}…` : t("admin.providers.no_evidence")}</small></div></div>
    <div className="provider-models">{provider.modelMappings.map((mapping) => <span key={mapping.modelProfileId}><strong>{mapping.providerModelName}</strong><small>{mapping.operations.join(" · ")} · {mapping.contextWindow.toLocaleString()}</small></span>)}</div>
    {canManage && <footer><button type="button" disabled={saving} onClick={() => void mutate(() => testExternalProvider(provider))}><Activity size={12} />{t("admin.providers.test")}</button><button type="button" disabled={saving || (provider.lifecycleState !== "healthy" && provider.contract.state !== "passed")} onClick={() => void mutate(() => setExternalProviderEnabled(provider, provider.lifecycleState !== "healthy"))}>{t(provider.lifecycleState === "healthy" ? "admin.providers.disable" : "admin.providers.enable")}</button>{provider.auth.credentialConfigured && <CredentialRotation provider={provider} saving={saving} t={t} mutate={mutate} />}<button type="button" className="provider-remove" disabled={saving || provider.lifecycleState !== "disabled"} title={provider.lifecycleState !== "disabled" ? t("admin.providers.remove_disabled_hint") : undefined} aria-expanded={confirmingRemoval} onClick={() => setConfirmingRemoval(true)}><Trash2 size={12} />{t("admin.providers.remove")}</button></footer>}
    {confirmingRemoval && <section className="provider-removal-confirmation" role="alertdialog" aria-labelledby={`provider-remove-title-${provider.providerId}`} aria-describedby={`provider-remove-description-${provider.providerId}`}>
      <AlertTriangle size={18} aria-hidden="true" />
      <div><strong id={`provider-remove-title-${provider.providerId}`}>{t("admin.providers.remove")}</strong><small id={`provider-remove-description-${provider.providerId}`}>{t("admin.providers.remove_confirm")}</small></div>
      <footer><button autoFocus type="button" className="secondary-button" disabled={saving} onClick={() => setConfirmingRemoval(false)}>{t("common.cancel")}</button><button type="button" className="danger-button" disabled={saving} onClick={() => void mutate(async () => { await removeExternalProvider(provider); setConfirmingRemoval(false); })}>{saving ? <LoaderCircle className="auth-spinner" size={12} aria-hidden="true" /> : <Trash2 size={12} aria-hidden="true" />}{t("admin.providers.remove")}</button></footer>
    </section>}
  </article>;
}

function CredentialRotation({ provider, saving, t, mutate }: { provider: ExternalProvider; saving: boolean; t: Translate; mutate: (operation: () => Promise<unknown>) => Promise<void> }) {
  return <details className="provider-credential"><summary><KeyRound size={12} />{t("admin.providers.rotate")}</summary><form onSubmit={(event) => { event.preventDefault(); const element = event.currentTarget, form = new FormData(element); void mutate(async () => { await rotateExternalProviderCredential(provider, String(form.get("credential"))); element.reset(); }); }}><input name="credential" type="password" minLength={8} maxLength={8192} autoComplete="new-password" required aria-label={t("admin.providers.credential")} /><button type="submit" disabled={saving}>{t("admin.providers.save")}</button></form></details>;
}

function ProviderForm({ saving, t, onSubmit }: { saving: boolean; t: Translate; onSubmit: (form: FormData) => Promise<void> }) {
  return <form className="provider-composer" onSubmit={(event) => { event.preventDefault(); void onSubmit(new FormData(event.currentTarget)); }}>
    <div className="provider-composer__heading"><strong>{t("admin.providers.new")}</strong><small>{t("admin.providers.secret_once")}</small></div>
    <div className="provider-form-grid">
      <label>{t("admin.providers.key")}<input name="providerKey" required pattern="[a-z][a-z0-9_.-]{2,127}" placeholder="lan.large-llm" /></label>
      <label>{t("admin.providers.display_name")}<input name="displayName" required /></label>
      <label className="provider-form-wide">{t("presentation.label_12")}<input name="endpoint" type="url" required pattern="https://.*" placeholder="https://compute.example.internal/v1" /></label>
      <label>{t("admin.providers.auth")}<select name="authScheme" defaultValue="bearer"><option value="bearer">{t("presentation.label_13")}</option><option value="api_key_header">{t("presentation.label_14")}</option><option value="none">{t("presentation.label_15")}</option></select></label>
      <label>{t("admin.providers.header")}<input name="headerName" defaultValue="X-API-Key" /></label>
      <label className="provider-form-wide">{t("admin.providers.credential")}<input name="credential" type="password" minLength={8} maxLength={8192} autoComplete="new-password" /></label>
      <label>{t("admin.providers.trust")}<select name="trustMode" defaultValue="system_ca"><option value="system_ca">{t("presentation.label_16")}</option><option value="custom_ca">{t("presentation.label_17")}</option></select></label>
      <label>{t("admin.providers.server_name")}<input name="serverName" /></label>
      <label className="provider-form-full">{t("admin.providers.ca")}<textarea name="customCaPem" rows={3} placeholder="-----BEGIN CERTIFICATE-----" /></label>
      <label>{t("admin.providers.data_classes")}<input name="allowedDataClasses" defaultValue="public,internal" required /></label>
      <label>{t("admin.providers.concurrency")}<input name="concurrency" type="number" min="1" max="4096" defaultValue="1" required /></label>
      <label>{t("admin.providers.rpm")}<input name="requestsPerMinute" type="number" min="1" defaultValue="60" required /></label>
      <label>{t("admin.providers.connect_timeout")}<input name="connectMilliseconds" type="number" min="100" defaultValue="5000" required /></label>
      <label>{t("admin.providers.request_timeout")}<input name="requestMilliseconds" type="number" min="100" defaultValue="120000" required /></label>
      <label>{t("admin.providers.stream_timeout")}<input name="idleStreamMilliseconds" type="number" min="1000" defaultValue="30000" required /></label>
      <label>{t("admin.providers.profile_id")}<input name="modelProfileId" required pattern="[0-9a-fA-F-]{36}" placeholder="00000000-0000-4000-8000-000000000018" /></label>
      <label>{t("admin.providers.provider_model")}<input name="providerModelName" required placeholder="large-llm" /></label>
      <label>{t("admin.providers.operations")}<input name="operations" required defaultValue="responses" /></label>
      <label>{t("admin.providers.context")}<input name="contextWindow" type="number" min="1" defaultValue="32768" required /></label>
      <label>{t("admin.providers.max_output")}<input name="maximumOutputTokens" type="number" min="0" defaultValue="4096" /></label>
      <label>{t("admin.providers.weight")}<input name="routingWeight" type="number" min="0" max="10000" defaultValue="100" required /></label>
      <label>{t("admin.providers.accounting")}<select name="accountingMode" defaultValue="unpriced"><option value="unpriced">{t("presentation.label_18")}</option><option value="provider_reported">{t("presentation.label_19")}</option><option value="platform_estimated">{t("presentation.label_20")}</option></select></label>
      <label>{t("admin.providers.currency")}<input name="currency" pattern="[A-Z]{3}" defaultValue="USD" required /></label>
    </div>
    <button type="submit" className="primary-button" disabled={saving}>{saving ? <LoaderCircle className="auth-spinner" size={14} /> : <Plus size={14} />}{t("admin.providers.save")}</button>
  </form>;
}

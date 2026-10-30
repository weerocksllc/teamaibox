import type { ProductLocale } from "../../../../packages/ui-system/src/locale-registry.mjs";
import {
  createPluginPreferenceSnapshotV1,
  type PluginPreferenceManifestV1,
} from "@teamaibox/plugin-sdk/preferences-v1";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { watchPluginPresentation } from "./plugin-presentation.mjs";

import type { ApplicationCatalogFact } from "../catalog/application-catalog-client";
import {
  catalogPreferenceCompatibilityV1,
  catalogPreferenceManifestV1,
  officialPluginPreferenceDeclarationV1,
  readActiveSemanticThemeTokensV1,
} from "../plugins/catalog-preferences.mjs";

type Translator = (key: string, values?: Record<string, string | number>) => string;

function manifest(fact: ApplicationCatalogFact): PluginPreferenceManifestV1 {
  const projected = catalogPreferenceManifestV1({ pluginKey: fact.pluginKey, ...fact.ui });
  const { localization, themes } = projected;
  if (!localization || !themes) throw new TypeError("Launchable application preference metadata is unavailable");
  return Object.freeze(projected) as PluginPreferenceManifestV1;
}

type WorkspaceProps = {
  fact: ApplicationCatalogFact;
  label: string;
  handoff?: unknown;
  locale: ProductLocale;
  direction: "ltr" | "rtl";
  theme: "light" | "dark";
  onClose: () => void;
  t: Translator;
};

export function DynamicApplicationWorkspace(props: WorkspaceProps) {
  const { fact, locale, direction, theme, label, onClose, t } = props;
  const setup = useMemo(() => {
    try {
      if (!fact.launchable || fact.route?.integration !== "iframe") return null;
      const preferenceManifest = manifest(fact);
      const compatibility = catalogPreferenceCompatibilityV1({
        app: { pluginKey: fact.pluginKey, ...fact.ui }, locale, direction, theme,
      });
      return { preferenceManifest, compatibility };
    } catch (error) {
      console.error('Unable to open application preferences', fact.pluginKey, error);
      return null;
    }
  }, [fact, locale, direction, theme]);
  if (!setup) return (
    <section className="plugin-workspace plugin-workspace--compatibility" role="region" aria-label={label}>
      <header className="plugin-workspace__header">
        <button type="button" className="text-button" onClick={onClose}><ArrowLeft size={18} aria-hidden="true" />{t("nav.home")}</button>
        <h2>{label}</h2>
      </header>
      <aside className="plugin-workspace__compatibility" role="alert">
        <AlertTriangle size={16} aria-hidden="true" /><strong>{t("app.compatibility.title")}</strong>
      </aside>
    </section>
  );
  return <CompatibleApplicationWorkspace {...props} {...setup} />;
}

function CompatibleApplicationWorkspace({ fact, label, handoff = null, locale, direction, theme, onClose, t, preferenceManifest, compatibility }: WorkspaceProps & {
  preferenceManifest: PluginPreferenceManifestV1;
  compatibility: ReturnType<typeof catalogPreferenceCompatibilityV1>;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const revision = useRef(0);
  const [presentedLocale, setPresentedLocale] = useState<string | null>(null);
  const [presentationFailed, setPresentationFailed] = useState(false);
  const [documentState, setDocumentState] = useState("waiting");
  const [presentationAttempt, setPresentationAttempt] = useState(0);
  const publishPreferences = useRef<() => void>(() => {});
  const checkPresentation = useRef<() => void>(() => {});
  const waitsForPresentation = fact.ui.official === true
    && preferenceManifest.localization === officialPluginPreferenceDeclarationV1.localization;
  const presentationReady = !waitsForPresentation || presentedLocale === compatibility.effective.locale;
  const initialSource = useRef<string | null>(null);
  if (initialSource.current === null) {
    // The outer workspace only mounts this component after validating the route.
    initialSource.current = `${fact.route!.pathPrefix}?locale=${encodeURIComponent(compatibility.effective.locale)}&theme=${encodeURIComponent(compatibility.effective.theme)}`;
  }
  const source = initialSource.current;
  const disclosureText = compatibility.disclosures.map((item) => {
    if (item.code === "locale-fallback") return t("app.compatibility.locale_fallback", { locale: item.effective });
    if (item.code === "direction-fallback") return t("app.compatibility.direction_fallback", { direction: item.effective });
    if (item.code === "theme-fallback") return t("app.compatibility.theme_fallback", { theme: item.effective });
    return t("app.compatibility.live_updates_unavailable");
  });

  useLayoutEffect(() => {
    const publish = () => {
      if (!frame.current?.contentWindow) return;
      const tokens = readActiveSemanticThemeTokensV1();
      revision.current += 1;
      const snapshot = createPluginPreferenceSnapshotV1({
        manifest: preferenceManifest,
        locale,
        direction,
        theme,
        tokenSets: { light: tokens, dark: tokens },
        revision: revision.current,
      });
      frame.current.contentWindow.postMessage(snapshot, globalThis.location.origin);
    };
    const publishWithHandoff = () => {
      publish();
      if (!frame.current?.contentWindow) return;
      if (handoff) frame.current.contentWindow.postMessage(handoff, globalThis.location.origin);
    };
    let monitor: ReturnType<typeof watchPluginPresentation> | null = null;
    const onReady = (event: MessageEvent) => {
      if (event.origin !== globalThis.location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "teamaibox.plugin-presentation-ready/v1" && event.data?.pluginId === fact.pluginKey
          && event.data?.locale === compatibility.effective.locale) {
        monitor?.check();
      }
      if (event.data?.type === "teamaibox.plugin-ready/v1" && event.data?.pluginId === fact.pluginKey) publishWithHandoff();
      if (event.data?.type === "teamaibox.plugin-handoff/v1" && event.data?.sourcePluginId === fact.pluginKey) {
        globalThis.dispatchEvent(new CustomEvent("teamaibox:plugin-handoff", { detail: event.data }));
      }
    };
    publishPreferences.current = publishWithHandoff;
    globalThis.addEventListener("message", onReady);
    if (waitsForPresentation) {
      monitor = watchPluginPresentation({
        frame: () => frame.current, source, origin: globalThis.location.origin,
        locale: compatibility.effective.locale, publish,
        onReady: (active: string) => { setPresentedLocale(active); setPresentationFailed(false); },
        onFailure: () => setPresentationFailed(true),
        onDocumentState: setDocumentState,
      });
    }
    checkPresentation.current = () => monitor?.check();
    const timer = globalThis.setTimeout(() => { try { publishWithHandoff(); } catch { setPresentationFailed(true); } }, 0);
    return () => {
      globalThis.removeEventListener("message", onReady); globalThis.clearTimeout(timer);
      monitor?.stop(); checkPresentation.current = () => {};
    };
  }, [compatibility.effective.locale, direction, fact.pluginKey, handoff, locale, preferenceManifest, theme, waitsForPresentation, source, presentationAttempt]);

  return (
    <section className={`plugin-workspace${disclosureText.length ? " plugin-workspace--compatibility" : ""}`} role="region" aria-labelledby="dynamic-application-workspace-title">
      <header className="plugin-workspace__header">
        <button type="button" className="text-button" onClick={onClose}><ArrowLeft size={18} aria-hidden="true" />{t("nav.home")}</button>
        <h2 id="dynamic-application-workspace-title">{label}</h2>
      </header>
      {disclosureText.length > 0 && <aside className="plugin-workspace__compatibility" role="status" aria-label={t("app.compatibility.title")}>
        <AlertTriangle size={16} aria-hidden="true" />
        <div><strong>{t("app.compatibility.title")}</strong><p>{disclosureText.join(" ")}</p></div>
      </aside>}
      {!presentationReady && <div className="plugin-workspace__presentation" role={presentationFailed ? "alert" : "status"}>
        <span>{presentationFailed ? t("applications.startup_failed") : t("applications.startup_loading")}</span>
        {presentationFailed && <button type="button" className="text-button" onClick={() => {
          setPresentationFailed(false);
          if (frame.current) frame.current.src = source;
          setPresentationAttempt((attempt) => attempt + 1);
        }}>{t("applications.retry")}</button>}
      </div>}
      <iframe ref={frame} className="plugin-workspace__frame" src={source} title={label}
        data-presentation={presentationReady ? "ready" : "loading"}
        data-presentation-document={documentState}
        aria-hidden={!presentationReady || undefined}
        sandbox={`allow-downloads allow-forms allow-same-origin allow-scripts${fact.pluginKey === "official.virtual-computers" ? " allow-popups" : ""}`}
        allow={fact.pluginKey === "official.virtual-phones" ? "camera 'self'; microphone 'none'" : "camera 'none'"}
        onError={() => setPresentationFailed(true)}
        onLoad={() => {
          try { publishPreferences.current(); } catch { setPresentationFailed(true); }
          checkPresentation.current();
          frame.current?.contentWindow?.postMessage({ type: "teamaibox.plugin-host-ready/v1" }, globalThis.location.origin);
        }} />
    </section>
  );
}

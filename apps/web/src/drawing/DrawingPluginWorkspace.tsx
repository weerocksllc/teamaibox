import type { ProductLocale } from "../../../../packages/ui-system/src/locale-registry.mjs";
import {
  createPluginPreferenceSnapshotV1,
  type PluginPreferenceManifestV1,
} from "@teamaibox/plugin-sdk/preferences-v1";
import { Palette, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { readActiveSemanticThemeTokensV1 } from "../plugins/catalog-preferences.mjs";

type Translator = (key: string, values?: Record<string, string | number>) => string;

const drawingManifest: PluginPreferenceManifestV1 = Object.freeze({
  id: "official.drawing",
  official: true,
  localization: Object.freeze({
    supportedLocales: Object.freeze(["zh-CN","zh-TW","en","ja","ko","fr","de","es","pt-BR","ru","ar","hi","id","it","tr","vi","th"] as const),
    fallbackLocale: "zh-CN",
    supportedDirections: Object.freeze(["ltr", "rtl"] as const),
    rtlReady: true,
  }),
  themes: Object.freeze({
    supported: Object.freeze(["light", "dark"] as const),
    usesSemanticTokens: true,
    livePreferenceEvents: true,
  }),
});

export function DrawingPluginWorkspace({ locale, direction, theme, onClose, t }: {
  locale: ProductLocale;
  direction: "ltr" | "rtl";
  theme: "light" | "dark";
  onClose: () => void;
  t: Translator;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const revision = useRef(0);
  const source = useMemo(
    () => `/plugins/official.drawing?locale=${encodeURIComponent(locale)}&theme=${encodeURIComponent(theme)}`,
    [],
  );

  useEffect(() => {
    const publish = () => {
      if (!frame.current?.contentWindow) return;
      const tokens = readActiveSemanticThemeTokensV1();
      revision.current += 1;
      const snapshot = createPluginPreferenceSnapshotV1({
        manifest: drawingManifest,
        locale,
        direction,
        theme,
        tokenSets: { light: tokens, dark: tokens },
        revision: revision.current,
      });
      frame.current.contentWindow.postMessage(snapshot, globalThis.location.origin);
    };
    const onReady = (event: MessageEvent) => {
      if (event.origin !== globalThis.location.origin || event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === "teamaibox.plugin-ready/v1" && event.data?.pluginId === "official.drawing") publish();
    };
    globalThis.addEventListener("message", onReady);
    const timer = globalThis.setTimeout(publish, 0);
    return () => {
      globalThis.removeEventListener("message", onReady);
      globalThis.clearTimeout(timer);
    };
  }, [direction, locale, theme]);

  return (
    <section className="plugin-workspace" role="dialog" aria-modal="true" aria-labelledby="drawing-workspace-title">
      <header className="plugin-workspace__header">
        <span className="plugin-workspace__brand"><Palette size={19} aria-hidden="true" /></span>
        <div><p>{t("drawing.workspace.eyebrow")}</p><h2 id="drawing-workspace-title">{t("app.drawing.name")}</h2></div>
        <span className="plugin-workspace__trust"><ShieldCheck size={13} aria-hidden="true" />{t("drawing.workspace.official")}</span>
        <button type="button" className="icon-button" onClick={onClose} aria-label={t("app.close")}><X size={20} aria-hidden="true" /></button>
      </header>
      <iframe
        ref={frame}
        className="plugin-workspace__frame"
        src={source}
        title={t("app.drawing.name")}
        sandbox="allow-downloads allow-forms allow-same-origin allow-scripts"
        onLoad={() => frame.current?.contentWindow?.postMessage({ type: "teamaibox.plugin-host-ready/v1" }, globalThis.location.origin)}
      />
    </section>
  );
}

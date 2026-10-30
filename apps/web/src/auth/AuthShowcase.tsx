import { FolderClosed, MessagesSquare, Monitor, ShieldCheck, Sparkles } from "lucide-react";
import { BrandLogo } from "../BrandLogo";

/** A capability illustration, not a live dashboard or a hardware product render. */
export function AuthShowcase({ t }: { t: (key: string) => string }) {
  return (
    <aside className="auth-showcase">
      <p className="auth-showcase__eyebrow">{t("auth.brand_eyebrow")}</p>
      <h2>{t("auth.brand_title")}<br /><span>{t("auth.brand_title_accent")}</span></h2>
      <p className="auth-showcase__description">{t("auth.brand_subtitle")}</p>

      <div className="auth-orbit" aria-hidden="true">
        <svg className="auth-orbit__lines" viewBox="0 0 640 270" fill="none">
          <ellipse cx="320" cy="175" rx="240" ry="70" />
          <ellipse cx="320" cy="175" rx="170" ry="48" />
          <path d="M80 175h480M320 30v215M150 80l340 170M150 250L490 80" />
        </svg>
        <div className="auth-orbit__core">
          <BrandLogo size={160} />
        </div>
        <span className="auth-orbit__label auth-orbit__label--ai"><Sparkles size={18} />{t("auth.feature_ai")}</span>
        <span className="auth-orbit__label auth-orbit__label--files"><FolderClosed size={18} />{t("auth.orbit_files")}</span>
        <span className="auth-orbit__label auth-orbit__label--devices"><Monitor size={18} />{t("auth.feature_devices")}</span>
        <span className="auth-orbit__caption">TEAM AI BOX</span>
      </div>

      <div className="auth-features">
        {([
          [Sparkles, "ai"], [MessagesSquare, "collaboration"], [Monitor, "devices"],
        ] as const).map(([Icon, key]) => (
          <section key={key}>
            <Icon size={21} strokeWidth={1.7} aria-hidden="true" />
            <h3>{t(`auth.feature_${key}`)}</h3>
            <p>{t(`auth.brand_${key}`)}</p>
          </section>
        ))}
      </div>
      <p className="auth-showcase__ownership"><ShieldCheck size={16} aria-hidden="true" />{t("auth.brand_ownership")}</p>
    </aside>
  );
}

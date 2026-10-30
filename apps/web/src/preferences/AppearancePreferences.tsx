import { ChevronDown, Globe2, Monitor, Moon, Sun } from "lucide-react";
import type { Locale } from "../i18n";
import "./appearance-preferences.css";
import { localeDefinitions, productLocaleName } from "../../../../packages/ui-system/src/locale-registry.mjs";

export type AppearanceTheme = "light" | "dark" | "system";

export function AppearancePreferences({ locale, theme, onLocaleChange, onThemeChange, t, variant = "toolbar" }: {
  locale: Locale;
  theme: AppearanceTheme;
  onLocaleChange: (locale: Locale) => void;
  onThemeChange: (theme: AppearanceTheme) => void;
  t: (key: string) => string;
  variant?: "toolbar" | "profile";
}) {
  const ThemeIcon = theme === "system" ? Monitor : theme === "dark" ? Moon : Sun;
  const languageLabel = t(variant === "profile" ? "profile.language" : "auth.language");
  const themeLabel = t(variant === "profile" ? "profile.theme" : "auth.theme");
  return (
    <div className={`appearance-preferences appearance-preferences--${variant}`} aria-label={t("auth.appearance")}>
      <label className="appearance-select" title={languageLabel}>
        <Globe2 size={18} aria-hidden="true" />
        {variant === "profile" && <span className="appearance-select__copy" aria-hidden="true"><small>{languageLabel}</small><strong>{productLocaleName(locale)}</strong></span>}
        <ChevronDown size={12} aria-hidden="true" />
        <select aria-label={languageLabel} value={locale} onChange={event => onLocaleChange(event.target.value as Locale)}>
          {localeDefinitions.map(({code,name})=><option key={code} value={code} lang={code}>{name}</option>)}
        </select>
      </label>
      <label className="appearance-select" title={themeLabel}>
        <ThemeIcon size={18} aria-hidden="true" />
        {variant === "profile" && <span className="appearance-select__copy" aria-hidden="true"><small>{themeLabel}</small><strong>{t(theme === "system" ? "auth.theme_system" : `theme.${theme}`)}</strong></span>}
        <ChevronDown size={12} aria-hidden="true" />
        <select aria-label={themeLabel} value={theme} onChange={event => onThemeChange(event.target.value as AppearanceTheme)}>
          <option value="light">{t("theme.light")}</option>
          <option value="dark">{t("theme.dark")}</option>
          <option value="system">{t("auth.theme_system")}</option>
        </select>
      </label>
    </div>
  );
}

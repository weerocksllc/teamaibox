import { ArrowRight, Check, Copy, KeyRound, LoaderCircle, LockKeyhole, RefreshCw, ShieldCheck, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { App } from "../App";
import { CompanyFooter } from "../CompanyFooter";
import { BrandLogo } from "../BrandLogo";
import { createI18nRuntime, type Locale } from "../i18n";
import {useAppearanceSync} from '../preferences/useAppearanceSync';
import {
  browserLocaleStorage,
  storedLocalePreference,
  persistLocalePreference,
  resolveInitialLocale,
} from "../preferences/locale-preference.mjs";
import {
  browserThemeStorage,
  persistThemePreference,
  resolveThemePreference,
  themeMetaColors,
} from "../preferences/theme-preference.mjs";
import {
  bootstrapOwner,
  createOwnerRecoveryChallenge,
  installAuthenticatedSession,
  loadAuthenticatedSession,
  loadSetupStatus,
  recoverOwner,
  type OwnerRecoveryChallenge,
  SessionClientError,
  signIn,
} from "./session-client";
import { SessionRealtimeBridge } from "./SessionRealtimeBridge";
import { AppearancePreferences, type AppearanceTheme } from "../preferences/AppearancePreferences";
import { withLoginAppearance, persistLoginAppearance } from "../preferences/login-appearance.mjs";
import { AuthShowcase } from "./AuthShowcase";
import "./login.css";

type Theme = "light" | "dark";
type Phase = "loading" | "setup" | "recovery" | "owner-recovery" | "anonymous" | "authenticated" | "unavailable";

function errorKey(error: unknown) {
  if (!(error instanceof SessionClientError)) return "auth.error_service";
  if (error.code === "invalid_credentials") return "auth.error_credentials";
  if (error.code === "authentication_throttled") return "auth.error_throttled";
  if (error.code === "https_required") return "auth.error_https";
  return "auth.error_service";
}

function setupErrorKey(error: unknown) {
  if (!(error instanceof SessionClientError)) return "setup.error_service";
  if (error.code === "bootstrap_complete") return "setup.error_complete";
  if (error.code === "https_required") return "auth.error_https";
  if (error.code === "setup_denied") return "setup.error_token";
  if (error.code === "setup_unavailable") return "setup.error_unprotected";
  if (error.code.startsWith("password_")) return "setup.error_password";
  if (error.code === "invalid_credentials" || error.code === "invalid_display_name") return "setup.error_fields";
  return "setup.error_service";
}

function ownerRecoveryErrorKey(error: unknown) {
  if (!(error instanceof SessionClientError)) return "owner_recovery.error_service";
  if (error.code === "recovery_failed") return "owner_recovery.error_failed";
  if (error.code === "recovery_throttled") return "owner_recovery.error_throttled";
  if (error.code === "recovery_unavailable") return "owner_recovery.error_unavailable";
  if (error.code === "https_required") return "auth.error_https";
  if (error.code.startsWith("password_")) return "setup.error_password";
  return "owner_recovery.error_service";
}

export function AuthenticatedApp() {
  const [developmentBootstrap] = useState(() => Boolean(globalThis.__TEAM_AI_BOX_AUTHORIZATION__));
  const [phase, setPhase] = useState<Phase>(developmentBootstrap ? "authenticated" : "loading");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [appearanceSaveFailed, setAppearanceSaveFailed] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([]);
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false);
  const [recoveryCopied, setRecoveryCopied] = useState(false);
  const [recoverySource, setRecoverySource] = useState<"setup" | "owner">("setup");
  const [ownerRecoveryAvailable, setOwnerRecoveryAvailable] = useState(false);
  const [ownerRecoveryChallenge, setOwnerRecoveryChallenge] = useState<OwnerRecoveryChallenge | null>(null);
  const [setupClaimProtected, setSetupClaimProtected] = useState(false);
  const [locale, setLocale] = useState<Locale>(() => resolveInitialLocale({
    storage: browserLocaleStorage(),
  }) as Locale);
  const localeChosen = useRef(false);
  const [systemDark, setSystemDark] = useState(() => globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
  const [themePreference, setThemePreference] = useState<AppearanceTheme>(() =>
    resolveThemePreference({ storage: browserThemeStorage() }) as AppearanceTheme);
  const theme: Theme = themePreference === "system" ? (systemDark ? "dark" : "light") : themePreference;
  useAppearanceSync(setLocale,setThemePreference);
  const i18n = useMemo(() => createI18nRuntime({ locale }), [locale]);
  const t = i18n.translate;
  const secureTransport = globalThis.__TEAM_AI_BOX_RUNTIME__?.transport === "https";

  const install = (session: Parameters<typeof installAuthenticatedSession>[0], appearance?: { locale: Locale; localeExplicit: boolean; theme: AppearanceTheme }) => {
    setAppearanceSaveFailed(false);
    installAuthenticatedSession(withLoginAppearance(session, appearance), () => {
      setError(null);
      setAppearanceSaveFailed(false);
      setLocale(resolveInitialLocale({ storage: browserLocaleStorage() }) as Locale);
      setThemePreference(resolveThemePreference({ storage: browserThemeStorage() }) as AppearanceTheme);
      setPhase("anonymous");
    });
    setPhase("authenticated");
    if (appearance) void persistLoginAppearance(session.preferences, appearance, globalThis.__TEAM_AI_BOX_PREFERENCE_TRANSPORT__)
      .catch(() => setAppearanceSaveFailed(true));
  };

  const checkSession = async () => {
    setPhase("loading");
    setError(null);
    try {
      const session = await loadAuthenticatedSession();
      if (session) install(session);
      else {
        const status = await loadSetupStatus();
        setSetupClaimProtected(status.claimProtected);
        setOwnerRecoveryAvailable(status.ownerRecoveryAvailable);
        setPhase(status.required ? "setup" : "anonymous");
      }
    } catch {
      setPhase("unavailable");
    }
  };

  useEffect(() => {
    if (developmentBootstrap) return undefined;
    let active = true;
    void loadAuthenticatedSession().then((session) => {
      if (!active) return;
      if (session) install(session);
      else void loadSetupStatus().then((status) => {
        if (active) {
          setSetupClaimProtected(status.claimProtected);
          setOwnerRecoveryAvailable(status.ownerRecoveryAvailable);
          setPhase(status.required ? "setup" : "anonymous");
        }
      }).catch(() => {
        if (active) setPhase("unavailable");
      });
    }).catch(() => {
      if (active) setPhase("unavailable");
    });
    return () => { active = false; };
  }, [developmentBootstrap]);

  useEffect(() => {
    // Once authenticated, App owns locale/theme and applies the account-first
    // preference. Keeping the authentication shell active here can overwrite
    // App with the pre-session device theme after the child effect runs.
    if (phase === "authenticated") return;
    document.documentElement.lang = i18n.locale;
    document.documentElement.dir = i18n.direction;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themeMetaColors[theme]);
  }, [i18n, theme, phase]);

  useEffect(() => {
    const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return undefined;
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  if (phase === "authenticated") {
    return (
      <>
        <SessionRealtimeBridge enabled={secureTransport && !developmentBootstrap} />
        <App />
        {appearanceSaveFailed && <div className="preference-save-notice" role="alert"><span>{t("auth.appearance_save_failed")}</span><button type="button" onClick={() => setAppearanceSaveFailed(false)} aria-label={t("common.close")}><X size={16} aria-hidden="true" /></button></div>}
      </>
    );
  }

  const changeLocale = (next: Locale) => {
    localeChosen.current = true;
    setLocale(next);
    void persistLocalePreference({ locale: next, storage: browserLocaleStorage() });
  };
  const changeTheme = (next: AppearanceTheme) => {
    setThemePreference(next);
    void persistThemePreference({ theme: next, storage: browserThemeStorage() });
  };

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!secureTransport || submitting) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setSubmitting(true);
    setError(null);
    try {
      const session = await signIn(String(data.get("loginName") || ""), String(data.get("password") || ""));
      form.reset();
      install(session, { locale, localeExplicit: localeChosen.current || storedLocalePreference() !== null, theme: themePreference });
    } catch (failure) {
      setError(errorKey(failure));
    } finally {
      setSubmitting(false);
    }
  };

  const submitSetup = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!secureTransport || submitting) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = String(data.get("password") || "");
    if (password !== String(data.get("passwordConfirmation") || "")) {
      setError("setup.error_mismatch");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await bootstrapOwner({
        loginName: String(data.get("loginName") || ""),
        displayName: String(data.get("displayName") || ""),
        password,
        setupToken: String(data.get("setupToken") || ""),
      });
      form.reset();
      setRecoveryCodes([...result.recoveryCodes]);
      setRecoverySource("setup");
      setRecoveryAcknowledged(false);
      setRecoveryCopied(false);
      setPhase("recovery");
    } catch (failure) {
      const key = setupErrorKey(failure);
      setError(key);
      if (failure instanceof SessionClientError && failure.code === "bootstrap_complete") {
        void checkSession();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const copyRecoveryCodes = async () => {
    try {
      await globalThis.navigator.clipboard.writeText(recoveryCodes.join("\n"));
      setRecoveryCopied(true);
    } catch {
      setError("setup.recovery_copy_failed");
    }
  };

  const finishRecovery = () => {
    if (!recoveryAcknowledged) return;
    setRecoveryCodes([]);
    setRecoveryAcknowledged(false);
    setRecoveryCopied(false);
    setOwnerRecoveryChallenge(null);
    setError(null);
    setPhase("anonymous");
  };

  const beginOwnerRecovery = async () => {
    if (!secureTransport || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const challenge = await createOwnerRecoveryChallenge();
      setOwnerRecoveryChallenge(challenge);
      setPhase("owner-recovery");
    } catch (failure) {
      setError(ownerRecoveryErrorKey(failure));
    } finally {
      setSubmitting(false);
    }
  };

  const submitOwnerRecovery = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!secureTransport || submitting || !ownerRecoveryChallenge) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const newPassword = String(data.get("newPassword") || "");
    if (newPassword !== String(data.get("passwordConfirmation") || "")) {
      setError("setup.error_mismatch");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await recoverOwner({
        challenge: ownerRecoveryChallenge.challenge,
        localRecoveryProof: String(data.get("localRecoveryProof") || ""),
        recoveryCode: String(data.get("recoveryCode") || ""),
        newPassword,
      });
      form.reset();
      setRecoveryCodes([...result.recoveryCodes]);
      setRecoverySource("owner");
      setRecoveryAcknowledged(false);
      setRecoveryCopied(false);
      setOwnerRecoveryChallenge(null);
      setPhase("recovery");
    } catch (failure) {
      setError(ownerRecoveryErrorKey(failure));
    } finally {
      setSubmitting(false);
    }
  };

  const recoveryCommand = ownerRecoveryChallenge
    ? `sudo docker exec "$(sudo docker ps -q --filter label=com.docker.compose.service=platform-api --filter status=running)" node /opt/teamaibox/apps/platform-api/bin/issue-owner-recovery-proof.mjs ${ownerRecoveryChallenge.challenge}`
    : "";

  return (
    <main className="auth-shell auth-shell--showcase">
      <header className="auth-masthead">
        <div className="auth-wordmark"><BrandLogo size={48} /><div className="auth-wordmark__copy"><strong>{t("brand.name")}</strong><small>Powered By DGX Spark</small></div></div>
        <AppearancePreferences locale={locale} theme={themePreference} onLocaleChange={changeLocale} onThemeChange={changeTheme} t={t} />
      </header>
      <AuthShowcase t={t} />
      <section className="auth-card" aria-labelledby="auth-title">
        {phase === "loading" ? (
          <div className="auth-state" role="status" aria-live="polite" aria-busy="true">
            <LoaderCircle className="auth-spinner" size={31} aria-hidden="true" />
            <h1 id="auth-title">{t("auth.loading_title")}</h1>
            <p>{t("auth.loading_body")}</p>
          </div>
        ) : phase === "unavailable" ? (
          <div className="auth-state" role="alert">
            <span className="auth-state__icon"><RefreshCw size={24} aria-hidden="true" /></span>
            <h1 id="auth-title">{t("auth.unavailable_title")}</h1>
            <p>{t("auth.unavailable_body")}</p>
            <button type="button" className="primary-button auth-retry" onClick={() => void checkSession()}>{t("auth.retry")}</button>
          </div>
        ) : phase === "setup" ? (
          <>
            <div className="auth-heading">
              <span className="auth-state__icon"><KeyRound size={24} aria-hidden="true" /></span>
              <p className="eyebrow">{t("setup.eyebrow")}</p>
              <h1 id="auth-title">{t("setup.title")}</h1>
              <p>{t("setup.subtitle")}</p>
            </div>
            {!secureTransport && <p className="auth-alert" role="alert">{t("auth.error_https")}</p>}
            {!setupClaimProtected && <p className="auth-alert" role="alert">{t("setup.error_unprotected")}</p>}
            {error && <p className="auth-alert" role="alert">{t(error)}</p>}
            <form className="auth-form" onSubmit={submitSetup}>
              <label htmlFor="setup-token">{t("setup.token")}</label>
              <input id="setup-token" name="setupToken" type="password" autoComplete="one-time-code" minLength={32} required disabled={!secureTransport || !setupClaimProtected || submitting} />
              <p className="auth-field-hint">{t("setup.token_hint")}</p>
              <label htmlFor="setup-login-name">{t("auth.login_name")}</label>
              <input id="setup-login-name" name="loginName" autoComplete="username" required disabled={!secureTransport || !setupClaimProtected || submitting} />
              <label htmlFor="setup-display-name">{t("setup.display_name")}</label>
              <input id="setup-display-name" name="displayName" autoComplete="name" required disabled={!secureTransport || !setupClaimProtected || submitting} />
              <label htmlFor="setup-password">{t("setup.password")}</label>
              <input id="setup-password" name="password" type="password" autoComplete="new-password" minLength={15} required disabled={!secureTransport || !setupClaimProtected || submitting} />
              <p className="auth-field-hint">{t("setup.password_hint")}</p>
              <label htmlFor="setup-password-confirmation">{t("setup.password_confirmation")}</label>
              <input id="setup-password-confirmation" name="passwordConfirmation" type="password" autoComplete="new-password" minLength={15} required disabled={!secureTransport || !setupClaimProtected || submitting} />
              <button className="primary-button auth-submit" type="submit" disabled={!secureTransport || !setupClaimProtected || submitting}>
                {submitting ? <><LoaderCircle className="auth-spinner" size={17} />{t("setup.creating")}</> : t("setup.create_owner")}
              </button>
            </form>
          </>
        ) : phase === "owner-recovery" && ownerRecoveryChallenge ? (
          <div className="owner-recovery">
            <div className="auth-heading">
              <span className="auth-state__icon"><ShieldCheck size={24} aria-hidden="true" /></span>
              <p className="eyebrow">{t("owner_recovery.eyebrow")}</p>
              <h1 id="auth-title">{t("owner_recovery.title")}</h1>
              <p>{t("owner_recovery.subtitle")}</p>
            </div>
            {!secureTransport && <p className="auth-alert" role="alert">{t("auth.error_https")}</p>}
            {error && <p className="auth-alert" role="alert">{t(error)}</p>}
            <div className="owner-recovery__operator">
              <strong>{t("owner_recovery.local_proof_title")}</strong>
              <p>{t("owner_recovery.local_proof_hint")}</p>
              <code>{recoveryCommand}</code>
              <small>{t("owner_recovery.expires", { time: new Intl.DateTimeFormat(locale, { timeStyle: "medium" }).format(new Date(ownerRecoveryChallenge.expiresAt)) })}</small>
            </div>
            <form className="auth-form" onSubmit={submitOwnerRecovery}>
              <label htmlFor="owner-recovery-code">{t("owner_recovery.code")}</label>
              <input id="owner-recovery-code" name="recoveryCode" type="password" autoComplete="one-time-code" required disabled={submitting} />
              <label htmlFor="owner-local-proof">{t("owner_recovery.local_proof")}</label>
              <textarea id="owner-local-proof" name="localRecoveryProof" rows={3} autoComplete="off" spellCheck={false} required disabled={submitting} />
              <label htmlFor="owner-new-password">{t("owner_recovery.new_password")}</label>
              <input id="owner-new-password" name="newPassword" type="password" autoComplete="new-password" minLength={15} required disabled={submitting} />
              <label htmlFor="owner-new-password-confirmation">{t("setup.password_confirmation")}</label>
              <input id="owner-new-password-confirmation" name="passwordConfirmation" type="password" autoComplete="new-password" minLength={15} required disabled={submitting} />
              <button className="primary-button auth-submit" type="submit" disabled={submitting}>
                {submitting ? <><LoaderCircle className="auth-spinner" size={17} />{t("owner_recovery.recovering")}</> : t("owner_recovery.submit")}
              </button>
              <button type="button" className="setup-copy" disabled={submitting} onClick={() => { setOwnerRecoveryChallenge(null); setError(null); setPhase("anonymous"); }}>
                {t("owner_recovery.cancel")}
              </button>
            </form>
          </div>
        ) : phase === "recovery" ? (
          <div className="setup-recovery">
            <div className="auth-heading">
              <span className="auth-state__icon"><ShieldCheck size={24} aria-hidden="true" /></span>
              <p className="eyebrow">{t(recoverySource === "owner" ? "owner_recovery.complete_eyebrow" : "setup.recovery_eyebrow")}</p>
              <h1 id="auth-title">{t(recoverySource === "owner" ? "owner_recovery.complete_title" : "setup.recovery_title")}</h1>
              <p>{t(recoverySource === "owner" ? "owner_recovery.complete_subtitle" : "setup.recovery_subtitle")}</p>
            </div>
            <p className="setup-recovery__warning" role="alert">{t("setup.recovery_warning")}</p>
            <ol className="setup-recovery__codes" aria-label={t("setup.recovery_codes_label") }>
              {recoveryCodes.map((code) => <li key={code}><code>{code}</code></li>)}
            </ol>
            {error && <p className="auth-alert" role="alert">{t(error)}</p>}
            <button type="button" className="setup-copy" onClick={() => void copyRecoveryCodes()}>
              {recoveryCopied ? <Check size={15} /> : <Copy size={15} />}
              {t(recoveryCopied ? "setup.recovery_copied" : "setup.recovery_copy")}
            </button>
            <label className="setup-recovery__acknowledgement">
              <input type="checkbox" checked={recoveryAcknowledged} onChange={(event) => setRecoveryAcknowledged(event.target.checked)} />
              <span>{t("setup.recovery_acknowledgement")}</span>
            </label>
            <button type="button" className="primary-button auth-submit" disabled={!recoveryAcknowledged} onClick={finishRecovery}>
              {t("setup.continue_sign_in")}
            </button>
          </div>
        ) : (
          <>
            <div className="auth-heading">
              <p className="eyebrow">{t("auth.eyebrow")}</p>
              <h1 id="auth-title">{t("auth.title")}</h1>
              <p>{t("auth.subtitle")}</p>
            </div>
            {!secureTransport && <p className="auth-alert" role="alert">{t("auth.error_https")}</p>}
            {error && <p className="auth-alert" role="alert">{t(error)}</p>}
            <form className="auth-form" onSubmit={submit}>
              <label htmlFor="login-name">{t("auth.login_name")}</label>
              <input id="login-name" name="loginName" autoComplete="username" required disabled={!secureTransport || submitting} />
              <label htmlFor="login-password">{t("auth.password")}</label>
              <input id="login-password" name="password" type="password" autoComplete="current-password" required disabled={!secureTransport || submitting} />
              <button className="primary-button auth-submit" type="submit" disabled={!secureTransport || submitting}>
                {submitting ? <><LoaderCircle className="auth-spinner" size={17} />{t("auth.signing_in")}</> : <>{t("auth.sign_in")}<ArrowRight size={18} aria-hidden="true" /></>}
              </button>
            </form>
            {ownerRecoveryAvailable && (
              <button type="button" className="setup-copy owner-recovery-entry" disabled={!secureTransport || submitting} onClick={() => void beginOwnerRecovery()}>
                <ShieldCheck size={15} aria-hidden="true" />{t("owner_recovery.open")}
              </button>
            )}
          </>
        )}
        <footer className="auth-footer"><LockKeyhole size={13} aria-hidden="true" />{t("auth.secure_transport")}</footer>
      </section>
      <CompanyFooter placement="login" />
    </main>
  );
}

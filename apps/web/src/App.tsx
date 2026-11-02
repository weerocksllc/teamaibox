import {useAppearanceSync} from './preferences/useAppearanceSync';
import {
  ArrowRight,
  ArrowDownToLine,
  AlertTriangle,
  AudioLines,
  Bell,
  Blocks,
  Bot,
  ChevronDown,
  CircleUserRound,
  CloudCog,
  Clock3,
  Cast,
  FileCheck2,
  FlaskConical,
  FolderKanban,
  Gauge,
  Grid2X2,
  HardDrive,
  House,
  Languages,
  LayoutDashboard,
  ListTodo,
  LockKeyhole,
  Menu,
  MessageSquareText,
  MessagesSquare,
  Monitor,
  Palette,
  PackageOpen,
  RefreshCw,
  ScanText,
  Smartphone,
  Search,
  SendHorizontal,
  Settings2,
  ShieldCheck,
  ShieldX,
  Sparkles,
  ScrollText,
  X,
  type LucideIcon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@teamaibox/ui-system/components";
import { CompanyFooter } from "./CompanyFooter";
import { BrandLogo } from "./BrandLogo";
import { containModalFocus, focusPopover } from "./modal-focus";
import { taskLabel } from "./activity/task-label";

import { applicationsFromCatalogFacts, buildWorkbenchCatalog, searchWorkbenchCatalog, reconcileOpenApplication } from "./catalog/workbench-catalog.mjs";
import { loadApplicationCatalog, type ApplicationCatalogFact } from "./catalog/application-catalog-client";
import { AssistantWorkspace } from "./assistant/AssistantWorkspace";
import { DynamicApplicationWorkspace } from "./applications/DynamicApplicationWorkspace";
import type { PluginHandoff } from "./translation/TranslationPluginWorkspace";
import { cancelUserTask, loadUserActivity, type UserActivityOverview, type UserServiceAvailability, type UserTask } from "./activity/user-activity-client";
import { startSerialRefresh } from "./activity/serial-refresh.mjs";
import { loadCastingNotices } from "./casting/invitation-notices.mjs";
import {
  administratorNavigation,
  visibleNavigation,
} from "./authorization/view-policy.mjs";
import { authorizationFromBootstrap } from "./authorization/browser-context.mjs";
import { createI18nRuntime, type Locale } from "./i18n";
import { AppearancePreferences } from "./preferences/AppearancePreferences";
import {
  browserLocaleStorage,
  persistLocalePreference,
  resolveInitialLocale,
} from "./preferences/locale-preference.mjs";
import {
  browserThemeStorage,
  persistThemePreference,
  resolveThemePreference,
  themeMetaColors,
} from "./preferences/theme-preference.mjs";
import {
  adminRoute,
  applicationRoute,
  parseWorkbenchRoute,
  workbenchRoute,
} from "./routing/workbench-routing.mjs";
import { categoryConfiguration } from "./workbench-data";
import {
  publishOfficialCatalogPreferencesV1,
  readActiveSemanticThemeTokensV1,
} from "./plugins/catalog-preferences.mjs";

type Theme = "light" | "dark";
type ThemePreference = Theme | "system";
type CatalogApp = Readonly<{
  pluginKey: string; categoryKey: string; labelKey: string; descriptionKey: string;
  iconKey: string; fallbackLabel: string; enabled: boolean; order: number;
  requiredPermissions: ReadonlyArray<string>; runtime: ApplicationCatalogFact;
}>;
type CatalogGroup = (typeof categoryConfiguration)[number] & { applications: readonly CatalogApp[] };
type AdminItem = { id: string; href: string; requiredPermissions: string[]; available: boolean };
type Translate = (key: string, values?: Record<string, string | number>) => string;

const UserAdministrationPanel = lazy(() => import("./users/UserAdministrationPanel").then((module) => ({ default: module.UserAdministrationPanel })));
const RoleAdministrationPanel = lazy(() => import("./roles/RoleAdministrationPanel").then((module) => ({ default: module.RoleAdministrationPanel })));
const TeamAdministrationPanel = lazy(() => import("./teams/TeamAdministrationPanel").then((module) => ({ default: module.TeamAdministrationPanel })));
const ModelAdministrationPanel = lazy(() => import("./models/ModelAdministrationPanel").then((module) => ({ default: module.ModelAdministrationPanel })));
const QueueAdministrationPanel = lazy(() => import("./queues/QueueAdministrationPanel").then((module) => ({ default: module.QueueAdministrationPanel })));
const PhoneAdministrationPanel = lazy(() => import("./phones/PhoneAdministrationPanel").then((module) => ({ default: module.PhoneAdministrationPanel })));
const ComputerAdministrationPanel = lazy(() => import("./computers/ComputerAdministrationPanel").then(module => ({default:module.ComputerAdministrationPanel})));
const AppliancePanel = lazy(() => import("./device/AppliancePanel").then((module) => ({ default: module.AppliancePanel })));
const ExternalProvidersPanel = lazy(() => import("./providers/ExternalProvidersPanel").then((module) => ({ default: module.ExternalProvidersPanel })));
const PluginAdministrationPanel = lazy(() => import("./plugins/PluginAdministrationPanel").then((module) => ({ default: module.PluginAdministrationPanel })));
const StorageAdministrationPanel = lazy(() => import("./storage/StorageAdministrationPanel").then((module) => ({ default: module.StorageAdministrationPanel })));
const EncryptionAdministrationPanel = lazy(() => import("./encryption/EncryptionAdministrationPanel").then((module) => ({ default: module.EncryptionAdministrationPanel })));
const SourceCenterPanel = lazy(() => import("./sources/SourceCenterPanel").then((module) => ({ default: module.SourceCenterPanel })));
const AuditPanel = lazy(() => import("./audit/AuditPanel").then((module) => ({ default: module.AuditPanel })));
const MaintenancePanel = lazy(() => import("./updates/MaintenancePanel").then((module) => ({ default: module.MaintenancePanel })));
const AdminOverviewPanel = lazy(() => import("./overview/AdminOverviewPanel").then((module) => ({ default: module.AdminOverviewPanel })));

const roleLabelPriority = ["owner", "system_admin", "compute_admin", "application_admin", "team_admin", "developer", "member", "guest"] as const;

function primaryRoleLabelKey(accountRoles: readonly string[]) {
  const role = roleLabelPriority.find((candidate) => accountRoles.includes(candidate));
  return role ? `role.${role}` : "profile.member_role";
}

const iconMap: Record<string, LucideIcon> = {
  messages: MessagesSquare,
  folder: FolderKanban,
  "folder-kanban": FolderKanban,
  sparkles: Sparkles,
  palette: Palette,
  "scan-text": ScanText,
  "audio-lines": AudioLines,
  languages: Languages,
  flask: FlaskConical,
  cast: Cast,
  smartphone: Smartphone,
  monitor: Monitor,
};

const adminIconMap: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  users: CircleUserRound,
  roles: ShieldCheck,
  team: MessagesSquare,
  device: Gauge,
  models: Bot,
  queues: ListTodo,
  phones: Smartphone,
  computers: Monitor,
  providers: CloudCog,
  plugins: Blocks,
  storage: HardDrive,
  sources: PackageOpen,
  encryption: LockKeyhole,
  updates: RefreshCw,
  audit: ScrollText,
};

const adminManagePermissions: Record<string, string | null> = {
  users: "identity:manage",
  roles: "role:manage",
  team: "team:manage",
  device: "node:manage",
  models: "model:manage",
  queues: "queue:manage",
  phones: "phone:manage",
  computers: "computer:manage",
  providers: "provider:manage",
  plugins: "plugin:manage",
  storage: "storage:manage",
  sources: "source:manage",
  encryption: "security:manage",
  updates: "update:manage",
  audit: null,
};

const availableAdminDomains = new Set(["overview", "users", "roles", "team", "device", "phones", "computers", "models", "queues", "providers", "plugins", "storage", "sources", "encryption", "updates", "audit"]);

const HANDOFF_REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;


function IconForApp({ app, size = 20 }: { app: CatalogApp; size?: number }) {
  const Icon = iconMap[app.iconKey] ?? Grid2X2;
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" />;
}

function ApplicationStartupTag({ app, t }: { app: CatalogApp; t: Translate }) {
  const state = app.runtime.startupState;
  if (app.runtime.authorized === false || app.runtime.launchable || !state || !["loading", "retrying", "failed", "unavailable"].includes(state)) return null;
  return <span className={`application-startup-tag application-startup-tag--${state}`} role="status"
    title={t(`applications.startup_${state}_detail`)}>{t(`applications.startup_${state}`)}</span>;
}

export function App() {
  const preferenceRevision = useRef(0);
  const initialRoute = parseWorkbenchRoute(globalThis.location?.pathname ?? "/") as {
    surface: "workbench" | "admin";
    adminItem: string;
    applicationPluginKey: string | null;
  };
  const [locale, setLocale] = useState<Locale>(() => resolveInitialLocale({
    accountLocale: globalThis.__TEAM_AI_BOX_ACCOUNT_PREFERENCES__?.preferredLocale,
    accountLocaleExplicit: globalThis.__TEAM_AI_BOX_ACCOUNT_PREFERENCES__?.preferredLocaleExplicit,
    storage: browserLocaleStorage(),
  }) as Locale);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => resolveThemePreference({
    accountTheme: globalThis.__TEAM_AI_BOX_ACCOUNT_PREFERENCES__?.preferredTheme,
    storage: browserThemeStorage(),
  }) as ThemePreference);
  const [systemDark, setSystemDark] = useState(
    () => globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  );
  const theme: Theme = themePreference === "system" ? (systemDark ? "dark" : "light") : themePreference;
  useAppearanceSync(setLocale,setThemePreference);
  const displayName = globalThis.__TEAM_AI_BOX_ACCOUNT_PREFERENCES__?.displayName || "林岚";
  const accountRoles = globalThis.__TEAM_AI_BOX_ACCOUNT_PREFERENCES__?.roles ?? ["owner"];
  const accountRoleLabelKey = primaryRoleLabelKey(accountRoles);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [taskOpen, setTaskOpen] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [castingNotices, setCastingNotices] = useState<ReadonlyArray<{id: string; expiresAt: string}>>([]);
  const [profileOpen, setProfileOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const sidebarPanel = useRef<HTMLElement>(null);
  const [activeApp, setActiveApp] = useState<CatalogApp | null>(null);
  const [requestedApplicationPluginKey, setRequestedApplicationPluginKey] = useState<string | null>(initialRoute.applicationPluginKey);
  const [pluginHandoff, setPluginHandoff] = useState<PluginHandoff | null>(null);
  const [assistantInitialPrompt, setAssistantInitialPrompt] = useState("");
  const [surface, setSurface] = useState<"workbench" | "admin">(initialRoute.surface);
  const [activeAdminItem, setActiveAdminItem] = useState(initialRoute.adminItem);
  const [applicationsScrollRequested, setApplicationsScrollRequested] = useState(false);
  const [activity, setActivity] = useState<UserActivityOverview | null>(null);
  const [activityState, setActivityState] = useState<"loading" | "ready" | "error">("loading");
  const [cancellingTaskId, setCancellingTaskId] = useState<string | null>(null);
  const [applicationFacts, setApplicationFacts] = useState<ReadonlyArray<ApplicationCatalogFact>>([]);
  const [catalogState, setCatalogState] = useState<"loading" | "ready" | "error">("loading");
  const [catalogRetryRevision, setCatalogRetryRevision] = useState(0);

  const i18n = useMemo(() => createI18nRuntime({
    locale,
    onDiagnostic: (diagnostic) => {
      globalThis.dispatchEvent(new CustomEvent("teamaibox:i18n-diagnostic", { detail: diagnostic }));
    },
  }), [locale]);
  const t = i18n.translate;
  const isDevelopmentPreview = globalThis.__TEAM_AI_BOX_RUNTIME__?.classification === "isolated-development-synthetic-only";
  const authorization = useMemo(() => authorizationFromBootstrap(
    globalThis.__TEAM_AI_BOX_AUTHORIZATION__,
    { developmentFallback: import.meta.env.DEV },
  ), []);
  const catalogApplications: readonly CatalogApp[] = useMemo(
    () => applicationsFromCatalogFacts(applicationFacts) as readonly CatalogApp[],
    [applicationFacts],
  );
  const catalog: readonly CatalogGroup[] = useMemo(() => buildWorkbenchCatalog({
    categories: categoryConfiguration,
    applications: catalogApplications,
    authorization,
  }), [authorization, catalogApplications]);
  const searchResults = useMemo(
    () => searchWorkbenchCatalog(catalog, searchQuery, t),
    [catalog, searchQuery, locale],
  );
  const assistantCatalogApp = useMemo(
    () => catalog.flatMap((group) => group.applications).find((app) => app.pluginKey === "official.assistant") ?? null,
    [catalog],
  );
  const adminItems: readonly AdminItem[] = useMemo(() => {
    const domains = visibleNavigation(administratorNavigation, authorization)
      .map((item: Omit<AdminItem, "available">) => ({ ...item, available: availableAdminDomains.has(item.id) }));
    if (domains.length === 0 || !new Set<string>(authorization.permissions as readonly string[]).has("operations:view")) return domains;
    return [{ id: "overview", href: "/admin", requiredPermissions: ["operations:view"], available: true }, ...domains];
  }, [authorization]);
  const canViewOwnTasks = new Set<string>(authorization.permissions as readonly string[]).has("task:own:view");
  const canReceiveCasting = new Set<string>(authorization.permissions as readonly string[]).has("cast:view");
  const castingApplication = catalogApplications.find(app => app.pluginKey === 'official.wireless-casting' && app.runtime.launchable);
  useEffect(() => {
    if (!canReceiveCasting || !castingApplication) { setCastingNotices([]); return; }
    let disposed = false;
    let inFlight = false;
    const controller = new AbortController();
    const refreshNotices = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const notices = await loadCastingNotices({signal: controller.signal});
        if (!disposed) setCastingNotices(notices);
      } catch { if (!disposed) setCastingNotices([]); }
      finally { inFlight = false; }
    };
    void refreshNotices();
    const timer = globalThis.setInterval(refreshNotices, 5000);
    globalThis.addEventListener('focus', refreshNotices);
    return () => { disposed = true; controller.abort(); clearInterval(timer); globalThis.removeEventListener('focus', refreshNotices); };
  }, [canReceiveCasting, Boolean(castingApplication)]);

  useEffect(() => {
    if (!requestedApplicationPluginKey || catalogState !== "ready") return;
    const target = catalog.flatMap((group) => group.applications)
      .find((application) => application.pluginKey === requestedApplicationPluginKey);
    setActiveApp((current) => reconcileOpenApplication(current, target, requestedApplicationPluginKey));
  }, [catalog, catalogState, requestedApplicationPluginKey]);

  useEffect(() => {
    return startSerialRefresh({
      request: (signal: AbortSignal) => loadApplicationCatalog({ signal }),
      onValue: (result: { applications: readonly ApplicationCatalogFact[] }) => {
        setApplicationFacts((previous) => JSON.stringify(previous) === JSON.stringify(result.applications)
          ? previous : result.applications);
        setCatalogState("ready");
      },
      onError: () => {
        setCatalogState("error");
      },
    });
  }, [catalogRetryRevision]);

  const retryApplicationCatalog = () => {
    setCatalogState("loading");
    setCatalogRetryRevision((revision) => revision + 1);
  };

  useEffect(() => {
    if (!canViewOwnTasks) { setActivity(null); setActivityState("ready"); return undefined; }
    return startSerialRefresh({
      request: (signal: AbortSignal) => loadUserActivity({ signal }),
      onValue: (next: UserActivityOverview) => { setActivity(next); setActivityState("ready"); },
      onError: () => setActivityState("error"),
    });
  }, [canViewOwnTasks]);

  useEffect(() => {
    document.documentElement.lang = i18n.locale;
    document.documentElement.dir = i18n.direction;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute(
      "content",
      themeMetaColors[theme],
    );
    const semanticTokens = readActiveSemanticThemeTokensV1();
    preferenceRevision.current += 1;
    publishOfficialCatalogPreferencesV1({
      applications: applicationFacts.filter((fact) => fact.ui.localization && fact.ui.themes).map((fact) => ({
        pluginKey: fact.pluginKey,
        official: fact.ui.official,
        localization: fact.ui.localization,
        themes: fact.ui.themes,
      })),
      locale: i18n.locale,
      direction: i18n.direction,
      theme,
      semanticTokens,
      revision: preferenceRevision.current,
      dispatch: (type: string, snapshot: unknown) => globalThis.dispatchEvent(new CustomEvent(type, { detail: snapshot })),
    });
  }, [applicationFacts, i18n, theme]);

  useEffect(() => {
    const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return undefined;
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const onPopState = () => {
      const route = parseWorkbenchRoute(globalThis.location?.pathname ?? "/") as {
        surface: "workbench" | "admin";
        adminItem: string;
        applicationPluginKey: string | null;
      };
      setSurface(route.surface);
      setActiveAdminItem(route.adminItem);
      setRequestedApplicationPluginKey(route.applicationPluginKey);
      if (route.applicationPluginKey === null) setActiveApp(null);
      setMobileMenuOpen(false);
    };
    globalThis.addEventListener("popstate", onPopState);
    return () => globalThis.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (surface !== "admin" || adminItems.length === 0) return;
    if (!availableAdminDomains.has(activeAdminItem)) return;
    if (adminItems.some((item) => item.id === activeAdminItem && item.available)) return;
    const fallbackItem = adminItems.find((item) => item.available)?.id ?? adminItems[0].id;
    setActiveAdminItem(fallbackItem);
    globalThis.history?.replaceState(null, "", adminRoute(fallbackItem));
  }, [activeAdminItem, adminItems, surface]);

  const openWorkbench = () => {
    setSurface("workbench");
    setMobileMenuOpen(false);
    setRequestedApplicationPluginKey(null);
    setActiveApp(null);
    setPluginHandoff(null);
    globalThis.history?.pushState(null, "", workbenchRoute());
  };

  const openAdmin = (item = activeAdminItem) => {
    setSurface("admin");
    setRequestedApplicationPluginKey(null);
    setActiveApp(null);
    setPluginHandoff(null);
    setActiveAdminItem(item);
    setMobileMenuOpen(false);
    globalThis.history?.pushState(null, "", adminRoute(item));
  };

  const openApplications = () => {
    openWorkbench();
    setApplicationsScrollRequested(true);
  };

  useEffect(() => {
    if (!applicationsScrollRequested || surface !== "workbench") return;
    document.getElementById("applications")?.scrollIntoView({ behavior: "smooth" });
    setApplicationsScrollRequested(false);
  }, [applicationsScrollRequested, surface]);

  useEffect(() => {
    const receiveHandoff = (event: Event) => {
      const detail = (event as CustomEvent).detail as Partial<PluginHandoff> | undefined;
      if (detail?.schemaVersion !== 1 || detail.type !== "teamaibox.plugin-handoff/v1"
          || typeof detail.sourcePluginId !== "string" || typeof detail.targetPluginId !== "string"
          || typeof detail.mediaType !== "string" || !HANDOFF_REFERENCE.test(detail.referenceId ?? "")) return;
      const target = catalog.flatMap((group) => group.applications).find((application) => application.pluginKey === detail.targetPluginId);
      if (!target?.runtime.launchable || !new Set(["official.ocr", "official.asr", "official.translation"]).has(target.pluginKey)) return;
      setPluginHandoff(detail as PluginHandoff);
      setSurface("workbench");
      setMobileMenuOpen(false);
      setActiveApp(target);
      setRequestedApplicationPluginKey(target.pluginKey);
      globalThis.history?.pushState(null, "", applicationRoute(target.pluginKey));
    };
    globalThis.addEventListener("teamaibox:plugin-handoff", receiveHandoff);
    return () => globalThis.removeEventListener("teamaibox:plugin-handoff", receiveHandoff);
  }, [catalog]);

  const changeLocale = (nextLocale: Locale) => {
    setLocale(nextLocale);
    void persistLocalePreference({
      locale: nextLocale,
      storage: browserLocaleStorage(),
      accountTransport: globalThis.__TEAM_AI_BOX_PREFERENCE_TRANSPORT__,
    }).catch(() => {
      globalThis.dispatchEvent(new CustomEvent("teamaibox:preference-save-failed", {
        detail: { preference: "locale" },
      }));
    });
  };

  const changeTheme = (nextTheme: ThemePreference) => {
    setThemePreference(nextTheme);
    void persistThemePreference({
      theme: nextTheme,
      storage: browserThemeStorage(),
      accountTransport: globalThis.__TEAM_AI_BOX_PREFERENCE_TRANSPORT__,
    }).catch(() => {
      globalThis.dispatchEvent(new CustomEvent("teamaibox:preference-save-failed", {
        detail: { preference: "theme" },
      }));
    });
  };

  const cancelTask = async (taskId: string) => {
    if (cancellingTaskId) return;
    setCancellingTaskId(taskId);
    try {
      const updated = await cancelUserTask(taskId);
      setActivity((current) => current ? {
        ...current,
        tasks: current.tasks.map((task) => task.taskId === taskId ? updated : task),
      } : current);
    } catch {
      setActivityState("error");
    } finally {
      setCancellingTaskId(null);
    }
  };

  useEffect(() => {
    if (!mobileMenuOpen || !sidebarPanel.current) return;
    const viewport = window.matchMedia("(max-width: 820px)");
    if (!viewport.matches) { setMobileMenuOpen(false); return; }
    const releaseFocus = containModalFocus(sidebarPanel.current);
    const onResize = () => { if (!viewport.matches) setMobileMenuOpen(false); };
    viewport.addEventListener("change", onResize);
    return () => { viewport.removeEventListener("change", onResize); releaseFocus(); };
  }, [mobileMenuOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setTaskOpen(false);
        setProfileOpen(false);
        setNotificationsOpen(false);
        setMobileMenuOpen(false);
        setSearchOpen(true);
      }
      if (event.key === "Escape") {
        if (searchOpen) { setSearchOpen(false); return; }
        if (taskOpen) { setTaskOpen(false); return; }
        if (profileOpen) { setProfileOpen(false); return; }
        if (notificationsOpen) { setNotificationsOpen(false); return; }
        if (mobileMenuOpen) { setMobileMenuOpen(false); return; }
        setActiveApp(null);
        setRequestedApplicationPluginKey(null);
        setPluginHandoff(null);
        if (parseWorkbenchRoute(globalThis.location?.pathname ?? "/").applicationPluginKey) {
          globalThis.history?.pushState(null, "", workbenchRoute());
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [searchOpen, taskOpen, profileOpen, notificationsOpen, mobileMenuOpen]);

  const openApplication = (app: CatalogApp) => {
    if (!app.runtime.launchable) return;
    setSurface("workbench");
    setMobileMenuOpen(false);
    setPluginHandoff(null);
    setActiveApp(app);
    setRequestedApplicationPluginKey(app.pluginKey);
    globalThis.history?.pushState(null, "", applicationRoute(app.pluginKey));
    setSearchOpen(false);
    setSearchQuery("");
  };

  const closeApplication = () => {
    setActiveApp(null);
    setRequestedApplicationPluginKey(null);
    setPluginHandoff(null);
    setAssistantInitialPrompt("");
    globalThis.history?.pushState(null, "", workbenchRoute());
  };

  const openMobileMenu = () => {
    setProfileOpen(false);
    setNotificationsOpen(false);
    setMobileMenuOpen(true);
  };

  const toggleMobileProfile = () => {
    setMobileMenuOpen(false);
    setNotificationsOpen(false);
    setProfileOpen((open) => !open);
  };

  return (
    <div className={`app-frame ${activeApp ? "app-frame--application" : ""} ${surface === "admin" ? "app-frame--admin" : ""} ${isDevelopmentPreview ? "app-frame--development-preview" : ""}`}>
      <aside ref={sidebarPanel} id="application-navigation" tabIndex={-1}
        role={mobileMenuOpen ? "dialog" : undefined} aria-modal={mobileMenuOpen || undefined}
        aria-label={t("nav.applications")} className={`sidebar ${mobileMenuOpen ? "sidebar--open" : ""}`}>
        <div className="brand-block">
          <div className="brand-mark"><BrandLogo size={38} /></div>
          <div>
            <strong>{t("brand.name")}</strong>
            <span>{t("brand.tagline")}</span>
          </div>
          <button className="sidebar-close" type="button" onClick={() => setMobileMenuOpen(false)} aria-label={t("common.close")}>
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <nav className="primary-nav" aria-label={t("nav.home")}>
          <button type="button" className={`nav-item ${surface === "workbench" && !activeApp ? "nav-item--active" : ""}`} aria-current={surface === "workbench" && !activeApp ? "page" : undefined} onClick={openWorkbench}>
            <House size={18} aria-hidden="true" />
            <span>{t("nav.home")}</span>
          </button>
          <button type="button" className="nav-item" onClick={openApplications}>
            <Grid2X2 size={18} aria-hidden="true" />
            <span>{t("nav.applications")}</span>
          </button>
          <button type="button" className="nav-item" onClick={() => { setMobileMenuOpen(false); setTaskOpen(true); }}>
            <ListTodo size={18} aria-hidden="true" />
            <span>{t("nav.tasks")}</span>
            {Boolean(activity?.summary.active) && <span className="nav-count">{activity!.summary.active}</span>}
          </button>
        </nav>

        <div className="sidebar-catalog">
          {surface === "workbench" && catalog.map((group) => (
            <section key={group.key} className="sidebar-group">
              <h2>{t(group.labelKey)}</h2>
              {group.applications.map((app: CatalogApp) => (
                <button key={app.pluginKey} type="button" className={`sidebar-app ${activeApp?.pluginKey === app.pluginKey ? "sidebar-app--active" : ""}`} data-startup={app.runtime.startupState} aria-current={activeApp?.pluginKey === app.pluginKey ? "page" : undefined} disabled={!app.runtime.launchable} title={!app.runtime.launchable ? t(`applications.startup_${app.runtime.startupState ?? "unavailable"}_detail`) : undefined} onClick={() => openApplication(app)}>
                  <IconForApp app={app} size={17} />
                  <span>{translatedApplicationText(app, "labelKey", t)}</span>
                  <ApplicationStartupTag app={app} t={t} />
                </button>
              ))}
            </section>
          ))}
          {surface === "admin" && adminItems.length > 0 && (
            <section className="sidebar-group">
              <h2>{t("admin.navigation")}</h2>
              {adminItems.map((item) => {
                const Icon = adminIconMap[item.id] ?? Settings2;
                const active = surface === "admin" && activeAdminItem === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`sidebar-app ${active ? "sidebar-app--active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    disabled={!item.available}
                    title={!item.available ? t("admin.not_available") : undefined}
                    onClick={() => item.available && openAdmin(item.id)}
                  >
                    <Icon size={17} aria-hidden="true" />
                    <span>{t(`admin.${item.id}.name`)}</span>
                  </button>
                );
              })}
            </section>
          )}
        </div>

        {surface === "workbench" && adminItems.some(item => item.available) && <Button variant="quiet" className="sidebar-admin-entry" onClick={() => openAdmin(adminItems.find(item => item.available)!.id)}><Settings2 size={18} aria-hidden="true" />{t("admin.navigation")}</Button>}

        <div className="device-status">
          <div className="device-status__icon"><Gauge size={18} aria-hidden="true" /></div>
          <div>
            <strong><span className={`status-dot status-dot--${activityState}`} />{t(activityState === "error" ? "services.summary.unavailable" : "services.summary.title")}</strong>
            <span>{activity ? t("services.summary.count", { count: activity.availability.filter((item) => new Set(["available", "busy"]).has(item.state)).length }) : t(activityState === "loading" ? "services.loading" : "services.no_data")}</span>
          </div>
        </div>
        <CompanyFooter placement="sidebar" />
      </aside>

      {mobileMenuOpen && <button className="scrim scrim--nav" tabIndex={-1} aria-hidden="true" aria-label={t("common.close")} onClick={() => setMobileMenuOpen(false)} />}

      <div className="workspace" inert={mobileMenuOpen}>
        {isDevelopmentPreview && (
          <div className="development-preview-banner" role="status" data-release-evidence-eligible="false">
            <AlertTriangle size={15} aria-hidden="true" />
            <strong>{t("preview.banner.title")}</strong>
            <span>{t("preview.banner.detail")}</span>
          </div>
        )}
        <header className="topbar">
          <span className="topbar-location">{activeApp ? translatedApplicationText(activeApp, "labelKey", t) : surface === "admin" ? (availableAdminDomains.has(activeAdminItem) ? `${t("admin.navigation")} / ${t(`admin.${activeAdminItem}.name`)}` : t("admin.navigation")) : t("nav.home")}</span>
          <button type="button" className="icon-button mobile-menu-trigger" onClick={openMobileMenu} aria-label={t("nav.applications")} aria-expanded={mobileMenuOpen} aria-controls="application-navigation">
            <Menu size={20} aria-hidden="true" />
          </button>
          <button className="global-search-trigger" type="button" onClick={() => setSearchOpen(true)}>
            <Search size={17} aria-hidden="true" />
            <span>{t("header.search")}</span>
            <kbd>{t("header.search_hint")}</kbd>
          </button>
          <div className="topbar-actions">
            <AppearancePreferences locale={locale} theme={themePreference} onLocaleChange={changeLocale} onThemeChange={changeTheme} t={t} />
            <button type="button" className="icon-button task-button" onClick={() => setTaskOpen(true)} aria-label={t("header.tasks")}>
              <ListTodo size={20} aria-hidden="true" />
              {Boolean(activity?.summary.active) && <span className="action-badge">{activity!.summary.active}</span>}
            </button>
            <div className="popover-anchor">
              <button type="button" className="icon-button" onClick={() => { setProfileOpen(false); setNotificationsOpen((open) => !open); }} aria-label={t("header.notifications")} aria-expanded={notificationsOpen}>
                <Bell size={20} aria-hidden="true" />
                {castingNotices.length > 0 && <span className="action-badge">{castingNotices.length}</span>}
              </button>
              {notificationsOpen && (
                <NotificationPopover t={t} count={castingNotices.length} onOpenCasting={() => {
                  if (castingApplication) openApplication(castingApplication);
                  setNotificationsOpen(false);
                }} onClose={() => setNotificationsOpen(false)} />
              )}
            </div>
            <div className="popover-anchor">
              <button type="button" className="profile-trigger" onClick={() => { setNotificationsOpen(false); setProfileOpen((open) => !open); }} aria-label={t("header.profile")} aria-expanded={profileOpen}>
                <span className="avatar">{[...displayName][0] || "AI"}</span>
                <span className="profile-name">{displayName}</span>
                <ChevronDown size={15} aria-hidden="true" />
              </button>
              {profileOpen && (
                <ProfilePopover
                  locale={locale}
                  setLocale={changeLocale}
                  theme={themePreference}
                  setTheme={changeTheme}
                  displayName={displayName}
                  roleLabelKey={accountRoleLabelKey}
                  onSignOut={() => {
                    setProfileOpen(false);
                    void globalThis.__TEAM_AI_BOX_SESSION_TRANSPORT__?.signOut();
                  }}
                  t={t}
                />
              )}
            </div>
          </div>
        </header>

        {castingNotices.length > 0 && activeApp?.pluginKey !== 'official.wireless-casting' && (
          <aside className="casting-invitation-banner" role="status" aria-live="polite">
            <Cast size={22} aria-hidden="true" />
            <div><strong>{t('casting.invitation.title')}</strong><span>{t('casting.invitation.detail')}</span></div>
            <button type="button" onClick={() => { if (castingApplication) openApplication(castingApplication); }}>{t('casting.invitation.open')}</button>
          </aside>
        )}

        {surface === "workbench" ? (
        <main className="main-content workbench-content" hidden={Boolean(activeApp)}>
          <div className="intro-row">
            <div>
              <p className="eyebrow">{t("home.eyebrow")}</p>
              <h1>{t("home.greeting", { name: displayName })}</h1>
              <p>{t("home.subtitle")}</p>
            </div>
            <div className="availability-pill">
              <span className={`status-dot status-dot--${activityState}`} />
              <span><strong>{t("section.service")}</strong>{activity ? t("services.summary.detail", { available: activity.availability.filter((item) => new Set(["available", "busy"]).has(item.state)).length, total: activity.availability.length }) : t(activityState === "loading" ? "services.loading" : "services.no_data")}</span>
            </div>
          </div>

          <div className="content-grid">
          <section className={`assistant-hero ${!assistantCatalogApp?.runtime.launchable ? "assistant-hero--unavailable" : ""}`} aria-labelledby="assistant-title">
            <div className="assistant-orb"><Bot size={29} strokeWidth={1.7} aria-hidden="true" /></div>
            <div className="assistant-copy">
              <h2 id="assistant-title">{t("assistant.title")}</h2>
              <p>{t("assistant.subtitle")}</p>
            </div>
            <form className="assistant-composer" onSubmit={(event) => {
              event.preventDefault();
              if (!assistantCatalogApp?.runtime.launchable) return;
              const data = new FormData(event.currentTarget);
              setAssistantInitialPrompt(String(data.get("prompt") || ""));
              openApplication(assistantCatalogApp);
            }}>
              <label className="sr-only" htmlFor="assistant-prompt">{t("assistant.placeholder")}</label>
              <input id="assistant-prompt" name="prompt" disabled={!assistantCatalogApp?.runtime.launchable} placeholder={assistantCatalogApp?.runtime.launchable ? t("assistant.placeholder") : t(`applications.startup_${assistantCatalogApp?.runtime.startupState ?? "unavailable"}_detail`)} />
              <span className="composer-mode"><Sparkles size={14} aria-hidden="true" />{t("assistant.mode")}</span>
              <button type="submit" disabled={!assistantCatalogApp?.runtime.launchable} aria-label={t("assistant.send")}><SendHorizontal size={18} aria-hidden="true" /><span>{t("assistant.send")}</span></button>
            </form>
            <div className="prompt-suggestions">
              {["assistant.suggestion.minutes", "assistant.suggestion.report", "assistant.suggestion.code"].map((key) => (
                <button key={key} type="button" disabled={!assistantCatalogApp?.runtime.launchable} onClick={() => {
                  setAssistantInitialPrompt(t(key));
                  if (assistantCatalogApp) openApplication(assistantCatalogApp);
                }}>{t(key)}<ArrowRight size={14} aria-hidden="true" /></button>
              ))}
            </div>
          </section>

            <section className="application-section" id="applications" aria-labelledby="applications-title">
              <div className="section-heading">
                <div>
                  <h2 id="applications-title">{t("section.all_apps")}</h2>
                </div>
                <button type="button" className="text-button" onClick={() => setSearchOpen(true)}>{t("section.view_all")}<ArrowRight size={15} aria-hidden="true" /></button>
              </div>

              <div className="category-stack">
                {catalogState !== "ready" && <div className="application-catalog-state" role={catalogState === "loading" ? "status" : "alert"} aria-live={catalogState === "loading" ? "polite" : undefined} aria-busy={catalogState === "loading" ? "true" : undefined}><AlertTriangle size={18} aria-hidden="true" /><div><strong>{t(catalogState === "loading" ? "applications.loading" : "applications.unavailable_title")}</strong><p>{t(catalogState === "loading" ? "applications.loading_detail" : "applications.unavailable_detail")}</p>{catalogState === "error" && <button type="button" className="text-button application-catalog-retry" onClick={retryApplicationCatalog}><RefreshCw size={14} aria-hidden="true" />{t("applications.retry")}</button>}</div></div>}
                {catalogState === "ready" && catalog.length === 0 && <div className="application-catalog-state" role="status"><PackageOpen size={18} aria-hidden="true" /><div><strong>{t("applications.empty_title")}</strong><p>{t("applications.empty_detail")}</p></div></div>}
                {catalog.map((group) => (
                  <section key={group.key} className="app-category">
                    <h3>{t(group.labelKey)}</h3>
                    <div className="app-grid">
                      {group.applications.map((app: CatalogApp) => (
                        <button key={app.pluginKey} type="button" className="application-card" data-startup={app.runtime.startupState} disabled={!app.runtime.launchable} onClick={() => openApplication(app)}>
                          <span className={`application-icon application-icon--${app.categoryKey}`}><IconForApp app={app} size={22} /></span>
                          <span className="application-card__copy">
                            <strong>{translatedApplicationText(app, "labelKey", t)} <ApplicationStartupTag app={app} t={t} /></strong>
                            <small>{app.runtime.launchable ? translatedApplicationText(app, "descriptionKey", t) : t(`applications.startup_${app.runtime.startupState ?? "unavailable"}_detail`)}</small>
                          </span>
                          <ArrowRight className="application-card__arrow" size={17} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            </section>

            <aside className="activity-panel" aria-labelledby="activity-title">
              <div className="section-heading section-heading--compact">
                <div>
                  <p className="eyebrow">{t("section.activity")}</p>
                  <h2 id="activity-title">{t("drawer.tasks_title")}</h2>
                </div>
                <button type="button" className="icon-button icon-button--small" onClick={() => setTaskOpen(true)} aria-label={t("section.task_center")}>
                  <ArrowRight size={17} aria-hidden="true" />
                </button>
              </div>
              <div className="task-list task-list--preview">
                {activityState === "loading" ? <ActivityState icon={Clock3} text={t("tasks.loading")} state="loading" />
                  : activityState === "error" ? <ActivityState icon={AlertTriangle} text={t("tasks.unavailable")} state="error" />
                    : (activity?.tasks.length ?? 0) === 0 ? <ActivityState icon={FileCheck2} text={t("tasks.empty")} state="empty" />
                      : activity!.tasks.slice(0, 3).map((task) => <TaskRow key={task.taskId} task={task} t={t} compact />)}
              </div>
              <button type="button" className="panel-link" onClick={() => setTaskOpen(true)}>{t("section.task_center")}<ArrowRight size={15} aria-hidden="true" /></button>
            </aside>
          </div>
          <details className="workbench-service-details"><summary>{t("section.service")}</summary><ServiceAvailabilityStrip availability={activity?.availability ?? []} applications={catalogApplications} state={activityState} t={t} /></details>
        </main>
        ) : adminItems.length > 0 ? (
          <AdminConsole
            items={adminItems}
            activeItem={activeAdminItem}
            permissions={authorization.permissions}
            roleLabelKey={accountRoleLabelKey}
            locale={i18n.locale}
            t={t}
          />
        ) : (
          <AdminAccessDenied onBack={openWorkbench} roleLabelKey={accountRoleLabelKey} t={t} />
        )}
      </div>

      <nav className="mobile-nav" inert={mobileMenuOpen} aria-label={t("nav.home")}>
        <button type="button" className={`mobile-nav__item ${surface === "workbench" ? "mobile-nav__item--active" : ""}`} aria-current={surface === "workbench" ? "page" : undefined} onClick={openWorkbench}><House size={20} aria-hidden="true" /><span>{t("mobile.home")}</span></button>
        <button type="button" className="mobile-nav__item" aria-expanded={mobileMenuOpen} aria-controls="application-navigation" onClick={openMobileMenu}><Grid2X2 size={20} aria-hidden="true" /><span>{t("mobile.apps")}</span></button>
        <button type="button" className="mobile-nav__item" aria-expanded={taskOpen} onClick={() => setTaskOpen(true)}><ListTodo size={20} aria-hidden="true" /><span>{t("mobile.tasks")}</span>{Boolean(activity?.summary.active) && <i>{activity!.summary.active}</i>}</button>
        <button type="button" className="mobile-nav__item" aria-expanded={profileOpen} onClick={toggleMobileProfile}><CircleUserRound size={20} aria-hidden="true" /><span>{t("mobile.me")}</span></button>
      </nav>

      {searchOpen && (
        <SearchDialog
          query={searchQuery}
          setQuery={setSearchQuery}
          results={searchResults}
          onOpen={openApplication}
          onClose={() => { setSearchOpen(false); setSearchQuery(""); }}
          t={t}
        />
      )}
      {taskOpen && <TaskDrawer tasks={activity?.tasks ?? []} state={activityState} cancellingTaskId={cancellingTaskId} onCancel={cancelTask} t={t} onClose={() => setTaskOpen(false)} />}
      {activeApp?.pluginKey === "official.assistant" && activeApp.runtime.route?.integration === "workbench" ? (
        <AssistantWorkspace locale={i18n.locale} initialPrompt={assistantInitialPrompt} onClose={closeApplication} t={t} />
      ) : activeApp?.runtime.route?.integration === "iframe" ? (
        <DynamicApplicationWorkspace key={activeApp.pluginKey} fact={activeApp.runtime} label={translatedApplicationText(activeApp, "labelKey", t)} handoff={pluginHandoff?.targetPluginId === activeApp.pluginKey ? pluginHandoff : null} locale={i18n.locale} direction={i18n.direction} theme={theme} onClose={closeApplication} t={t} />
      ) : null}
    </div>
  );
}

function AdminConsole({ items, activeItem, permissions, roleLabelKey, locale, t }: {
  items: readonly AdminItem[];
  activeItem: string;
  permissions: readonly string[];
  roleLabelKey: string;
  locale: string;
  t: (key: string) => string;
}) {
  if (!availableAdminDomains.has(activeItem)) {
    return <main className="admin-workspace"><h1>{t("admin.not_available")}</h1></main>;
  }
  const selected = items.find((item) => item.id === activeItem && item.available)
    ?? items.find((item) => item.available)
    ?? items[0];
  const managePermission = selected ? adminManagePermissions[selected.id] : null;
  const canManage = managePermission !== null && permissions.includes(managePermission);
  return (
    <main className="main-content admin-console">
      <div className="admin-intro">
        <div>
          <p className="eyebrow">{t("admin.eyebrow")}</p>
          <h1>{selected ? t(`admin.${selected.id}.name`) : t("admin.title")}</h1>
          <p>{selected ? t(`admin.${selected.id}.description`) : t("admin.subtitle")}</p>
        </div>
        <div className="admin-intro__badges">
          <span className="admin-scope-badge"><ShieldCheck size={15} aria-hidden="true" />{t(roleLabelKey)}</span>
          {selected?.id !== "overview" && (
            <span className={canManage ? "access-tag access-tag--manage" : "access-tag"}>
              {canManage ? <ShieldCheck size={13} aria-hidden="true" /> : <Clock3 size={13} aria-hidden="true" />}
              {t(canManage ? "admin.manage" : "admin.read_only")}
            </span>
          )}
        </div>
      </div>

      <Suspense fallback={<div className="admin-panel-loading" role="status" aria-live="polite" aria-busy="true"><RefreshCw size={18} aria-hidden="true" />{t("admin.loading")}</div>}>
        {selected?.id === "overview" && <AdminOverviewPanel t={t} />}
        {selected?.id === "users" && <UserAdministrationPanel locale={locale} canManage={canManage} actorIdentityId={globalThis.__TEAM_AI_BOX_ACCOUNT_PREFERENCES__?.identityId ?? null} t={t} />}
        {selected?.id === "roles" && <RoleAdministrationPanel canManage={canManage} actorIdentityId={globalThis.__TEAM_AI_BOX_ACCOUNT_PREFERENCES__?.identityId ?? null} t={t} />}
        {selected?.id === "team" && <TeamAdministrationPanel canManage={canManage} actorIdentityId={globalThis.__TEAM_AI_BOX_ACCOUNT_PREFERENCES__?.identityId ?? null} t={t} />}
        {selected?.id === "models" && <ModelAdministrationPanel locale={locale} canManage={canManage} t={t} />}
        {selected?.id === "queues" && <QueueAdministrationPanel locale={locale} canManage={canManage} t={t} />}
        {selected?.id === "phones" && <PhoneAdministrationPanel locale={locale} canManage={canManage} canViewStorage={permissions.includes("storage:view")} />}
        {selected?.id === "computers" && <ComputerAdministrationPanel locale={locale} canManage={canManage} />}
        {selected?.id === "device" && <AppliancePanel permissions={permissions} t={t} />}
        {selected?.id === "providers" && <ExternalProvidersPanel canManage={canManage} t={t} />}
        {selected?.id === "plugins" && <PluginAdministrationPanel canManage={canManage} t={t} />}
        {selected?.id === "storage" && <StorageAdministrationPanel locale={locale} canManage={canManage} t={t} />}
        {selected?.id === "encryption" && <EncryptionAdministrationPanel locale={locale} canManage={canManage} t={t} />}
        {selected?.id === "sources" && <SourceCenterPanel canManage={canManage} t={t} />}
        {selected?.id === "audit" && <AuditPanel locale={locale} t={t} />}
        {selected?.id === "updates" && <MaintenancePanel canManage={canManage} t={t} />}
      </Suspense>
    </main>
  );
}

function AdminAccessDenied({ onBack, roleLabelKey, t }: { onBack: () => void; roleLabelKey: string; t: Translate }) {
  return (
    <main className="main-content admin-access-denied">
      <div className="admin-access-denied__icon"><ShieldX size={30} aria-hidden="true" /></div>
      <p className="eyebrow">{t("admin.denied.eyebrow")}</p>
      <h1>{t("admin.denied.title")}</h1>
      <p>{t("admin.denied.description")}</p>
      <span className="admin-scope-badge"><CircleUserRound size={15} aria-hidden="true" />{t(roleLabelKey)}</span>
      <button type="button" className="primary-button" onClick={onBack}><House size={15} aria-hidden="true" />{t("admin.denied.back")}</button>
    </main>
  );
}

const taskIcons: Record<string, LucideIcon> = { assistant: Sparkles, chat: Sparkles, agent: Bot, drawing: Palette, image: Palette, ocr: ScanText, asr: AudioLines, translation: Languages, file: FileCheck2 };

function taskDetail(task: UserTask, t: Translate) {
  if (task.cancellationRequested) return t("tasks.cancellation_requested");
  if (task.failure) return t(task.failure.guidanceKey);
  if (task.wait.reasonKey && task.wait.estimatedSeconds !== null) return t("tasks.wait_estimate", { seconds: task.wait.estimatedSeconds });
  if (task.wait.reasonKey) return t(task.wait.reasonKey);
  if (task.state === "completed" && task.results.length > 0) return t("tasks.result_ready");
  return t(`tasks.detail.${task.state}`);
}

function TaskRow({ task, t, compact = false, cancelling = false, onCancel }: { task: UserTask; t: Translate; compact?: boolean; cancelling?: boolean; onCancel?: (taskId: string) => void }) {
  const Icon = taskIcons[task.taskKind] ?? ListTodo;
  const stateClass = task.state === "completed" ? "done" : task.state === "queued" || task.state === "preparing" ? "queued" : task.state === "failed" ? "failed" : "running";
  return (
    <article className={`task-row ${compact ? "task-row--compact" : ""}`} data-task-state={task.state}>
      <span className="task-icon"><Icon size={18} aria-hidden="true" /></span>
      <span className="task-copy">
        <strong>{taskLabel(task.titleKey, t)}</strong>
        <small className="task-summary"><span className="task-status-label"><span className={`task-state task-state--${stateClass}`} />{t(`task.${task.state}`)}</span><span className="task-detail">{taskDetail(task, t)}</span></small>
        {!compact && <span className="progress-track" role="progressbar" aria-label={taskLabel(task.titleKey, t)} aria-valuenow={task.progress} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${task.progress}%` }} /></span>}
        {!compact && task.results.length > 0 && <span className="task-result-links">{task.results.map((result) => <a key={result.artifactRef} href={`/api/v1/user/tasks/${encodeURIComponent(result.artifactRef)}/result`}>{t("tasks.result.download")}<ArrowDownToLine size={13} aria-hidden="true" /></a>)}</span>}
        {!compact && task.canCancel && onCancel && <button type="button" className="task-inline-action" disabled={cancelling} onClick={() => onCancel(task.taskId)}>{t(cancelling ? "tasks.cancelling" : "task.cancel")}<ArrowRight size={13} aria-hidden="true" /></button>}
      </span>
      <span className="task-progress">{Math.round(task.progress)}%</span>
    </article>
  );
}

function ActivityState({ icon: Icon, text, state }: { icon: LucideIcon; text: string; state: "loading" | "empty" | "error" }) {
  return <div className="activity-state" role={state === "error" ? "alert" : "status"} aria-live={state === "error" ? undefined : "polite"} aria-busy={state === "loading" ? "true" : undefined}><Icon size={17} aria-hidden="true" /><span>{text}</span></div>;
}

function translatedApplicationText(app: CatalogApp, field: "labelKey" | "descriptionKey", t: Translate) {
  const key = app[field];
  const translated = t(key);
  return translated === key ? app.fallbackLabel : translated;
}

function ServiceAvailabilityStrip({ availability, applications, state, t }: { availability: ReadonlyArray<UserServiceAvailability>; applications: readonly CatalogApp[]; state: "loading" | "ready" | "error"; t: Translate }) {
  const appName = (applicationKey: string) => {
    const app = applications.find((item) => item.pluginKey === applicationKey);
    return app ? translatedApplicationText(app, "labelKey", t) : t("services.unknown");
  };
  return (
    <section className="service-strip" aria-labelledby="service-strip-title">
      <div className="service-strip__heading"><div><p className="eyebrow">{t("services.eyebrow")}</p><h2 id="service-strip-title">{t("services.title")}</h2></div><small>{t("services.privacy")}</small></div>
      {state !== "ready" ? <ActivityState icon={state === "loading" ? Clock3 : AlertTriangle} text={t(state === "loading" ? "services.loading" : "services.no_data")} state={state} />
        : availability.length === 0 ? <ActivityState icon={Gauge} text={t("services.no_data")} state="empty" />
          : <div className="service-grid">{availability.map((item) => <article key={item.applicationKey} className={`service-chip service-chip--${item.state}`}><span className="service-chip__state" aria-hidden="true" /><div><strong>{appName(item.applicationKey)}</strong><small>{t(`services.state.${item.state}`)} · {item.wait.estimatedSeconds === 0 ? t("services.wait.now") : item.wait.estimatedSeconds !== null ? t("services.wait.seconds", { seconds: item.wait.estimatedSeconds }) : t("services.wait.unknown")}</small></div></article>)}</div>}
    </section>
  );
}

function SearchDialog({ query, setQuery, results, onOpen, onClose, t }: {
  query: string;
  setQuery: (value: string) => void;
  results: CatalogApp[];
  onOpen: (app: CatalogApp) => void;
  onClose: () => void;
  t: (key: string) => string;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => panel.current ? containModalFocus(panel.current) : undefined, []);
  return (
    <div className="modal-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section ref={panel} tabIndex={-1} className="search-dialog" role="dialog" aria-modal="true" aria-labelledby="search-title"
        onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
        <div className="search-dialog__input">
          <Search size={20} aria-hidden="true" />
          <label className="sr-only" htmlFor="global-search">{t("search.title")}</label>
          <input id="global-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("search.placeholder")} />
          <button type="button" onClick={onClose} aria-label={t("search.close")}><X size={18} aria-hidden="true" /></button>
        </div>
        <div className="search-dialog__body">
          <h2 id="search-title">{t("search.results")}</h2>
          {results.length === 0 ? (
            <div className="empty-search"><Search size={24} aria-hidden="true" /><p>{t("search.empty")}</p></div>
          ) : results.map((app) => (
            <button key={app.pluginKey} type="button" className="search-result" onClick={() => onOpen(app)}>
              <span className="application-icon"><IconForApp app={app} /></span>
              <span><strong>{translatedApplicationText(app, "labelKey", t)}</strong><small>{translatedApplicationText(app, "descriptionKey", t)}</small></span>
              <ArrowRight size={16} aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function TaskDrawer({ tasks, state, cancellingTaskId, onCancel, t, onClose }: { tasks: ReadonlyArray<UserTask>; state: "loading" | "ready" | "error"; cancellingTaskId: string | null; onCancel: (taskId: string) => void; t: Translate; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => panel.current ? containModalFocus(panel.current) : undefined, []);
  return (
    <div className="drawer-layer">
      <button type="button" className="scrim" tabIndex={-1} aria-hidden="true" aria-label={t("common.close")} onClick={onClose} />
      <aside ref={panel} tabIndex={-1} className="drawer" role="dialog" aria-modal="true" aria-labelledby="task-drawer-title"
        onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
        <div className="drawer-heading">
          <div><p className="eyebrow">{t("section.activity")}</p><h2 id="task-drawer-title">{t("drawer.tasks_title")}</h2><span>{t("drawer.tasks_subtitle")}</span></div>
          <button className="icon-button" type="button" onClick={onClose} aria-label={t("common.close")}><X size={19} aria-hidden="true" /></button>
        </div>
        <div className="drawer-content"><div className="task-list">{state === "loading" ? <ActivityState icon={Clock3} text={t("tasks.loading")} state="loading" />
          : state === "error" ? <ActivityState icon={AlertTriangle} text={t("tasks.unavailable")} state="error" />
            : tasks.length === 0 ? <ActivityState icon={FileCheck2} text={t("tasks.empty")} state="empty" />
              : tasks.map((task) => <TaskRow key={task.taskId} task={task} t={t} cancelling={cancellingTaskId === task.taskId} onCancel={onCancel} />)}</div>
        <section className="confirmation-section" aria-labelledby="agent-confirmation-title">
          <div className="confirmation-heading">
            <span><Bot size={18} aria-hidden="true" /></span>
            <div><h3 id="agent-confirmation-title">{t("confirmation.heading")}</h3><p>{t("confirmation.subtitle")}</p></div>
          </div>
          <p className="confirmation-empty">{t("confirmation.open_assistant")}</p>
        </section></div>
      </aside>
    </div>
  );
}

function NotificationPopover({ t, count, onOpenCasting, onClose }: { t: (key: string) => string; count: number; onOpenCasting: () => void; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => panel.current ? focusPopover(panel.current) : undefined, []);
  return (
    <section ref={panel} tabIndex={-1} className="popover notification-popover" aria-labelledby="notification-title">
      <div className="popover-heading"><div><h2 id="notification-title">{t("drawer.notifications_title")}</h2></div><button type="button" onClick={onClose} aria-label={t("common.close")}><X size={17} aria-hidden="true" /></button></div>
      {count > 0 ? <button type="button" className="notification-row casting-notice-button" onClick={onOpenCasting}><Cast size={20} aria-hidden="true" /><span>{t('casting.invitation.title')}<small>{t('casting.invitation.open')}</small></span></button> : <p>{t('casting.invitation.empty')}</p>}
    </section>
  );
}

function ProfilePopover({ locale, setLocale, theme, setTheme, displayName, roleLabelKey, onSignOut, t }: {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  displayName: string;
  roleLabelKey: string;
  onSignOut: () => void;
  t: (key: string) => string;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => panel.current ? focusPopover(panel.current) : undefined, []);
  return (
    <section ref={panel} tabIndex={-1} className="popover profile-popover" aria-label={t("profile.personal")}>
      <div className="profile-summary"><span className="avatar avatar--large">{[...displayName][0] || "AI"}</span><p><strong>{displayName}</strong><small>{t(roleLabelKey)}</small></p></div>
      <AppearancePreferences variant="profile" locale={locale} theme={theme} onLocaleChange={setLocale} onThemeChange={setTheme} t={t} />
      <button type="button" className="signout-button" onClick={onSignOut}>{t("profile.signout")}</button>
    </section>
  );
}

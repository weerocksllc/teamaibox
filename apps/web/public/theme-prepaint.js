(function applyThemeBeforePaint() {
  var allowed = { light: true, dark: true, system: true };
  var account = globalThis.__TEAM_AI_BOX_ACCOUNT_PREFERENCES__;
  var preference = account && allowed[account.preferredTheme] ? account.preferredTheme : null;
  if (!preference) {
    try {
      var stored = globalThis.localStorage && globalThis.localStorage.getItem("teamaibox.recent-theme");
      preference = allowed[stored] ? stored : null;
    } catch (_error) {
      preference = null;
    }
  }
  var systemDark = globalThis.matchMedia
    && globalThis.matchMedia("(prefers-color-scheme: dark)").matches;
  var theme = preference && preference !== "system"
    ? preference
    : systemDark ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}());

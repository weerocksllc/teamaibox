/** Only an explicit login-page language choice overrides a saved account choice. */
export function withLoginAppearance(session, appearance) {
  if (!appearance) return session;
  return { ...session, preferences: { ...session.preferences,
    ...(appearance.localeExplicit ? { preferredLocale: appearance.locale, preferredLocaleExplicit: true } : {}),
    preferredTheme: appearance.theme } };
}

export async function persistLoginAppearance(previous, appearance, transport) {
  const writes = [];
  if (appearance.localeExplicit && (previous.preferredLocale !== appearance.locale || !previous.preferredLocaleExplicit)) {
    writes.push(transport.updatePreferredLocale(appearance.locale));
  }
  if (previous.preferredTheme !== appearance.theme) writes.push(transport.updatePreferredTheme(appearance.theme));
  await Promise.all(writes);
}

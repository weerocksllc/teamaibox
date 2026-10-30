# Web Shell

Browser workbench and administrator console. This component owns navigation,
plugin surfaces, the unified AI conversation shell, task/notification
presentation, responsive layout, locale selection, and Light/Dark preference.

The client uses React 19, TypeScript 7, and Vite 8 with semantic CSS tokens and
Lucide's accessible icon components. Application groups and entries are built
from category configuration plus authorized plugin-registry metadata; adding an
application does not require changing shell navigation code.

It calls only authenticated platform APIs and public plugin contracts. It does
not own identity rules, job state, compute routing, persistent messages/files,
or direct OpenCode/worker connections.

The login page and authenticated navigation share `CompanyFooter`: copyright
year and Weerocks LLC, plus the `teamaibox@weerocks.llc` email link. It follows
the current theme and keeps the address left-to-right in RTL languages. The
footer participates in layout and stays above the mobile dock; it never floats
over an application or composer.

Official AI Drawing and Text Recognition surfaces are iframe-hosted
`ApplicationPlugin` containers. The host validates exact-origin readiness and
handoff messages, forwards the full locale/theme snapshot, and keeps close and
trust controls in the platform shell. Both plugins remain responsive down to
phone-width browsers even though no native mobile client is planned.

## Internationalization contract

First-party copy is stored in domain namespaces. Simplified Chinese (`zh-CN`)
and English (`en`) are required and catalog parity is tested. Lookup follows
`selected locale → en → visible key`; every fallback or missing key emits one
diagnostic per runtime. Dates, times, numbers, units, lists, relative time, and
plural selection use `Intl` with the active locale, while the document `lang`
and `dir` attributes change atomically without reloading application state.

Locale resolution uses an explicit browser-local choice, then an explicitly
selected account locale (`preferredLocaleExplicit`), then English (`en`). Browser
and operating-system languages never select or change the product language.
The English default is never persisted as manual intent. Manual choices survive refresh and sign-in
and are saved through the existing self-service preference transport. Existing
browser `teamaibox.recent-locale` entries came only from menu actions and remain
valid; historical account values alone have no reliable source metadata and
are retained but not treated as proof of a manual choice. Sign-in promotes an
existing browser manual choice to the account marker. All app frames receive
the shell's resolved locale; they do not independently choose another language.

## Theme contract

Light and Dark each define the complete semantic token set for canvas and
surfaces, text, borders, interaction/selection/focus/disabled states,
success/warning/error/info, six chart series, code and log surfaces, and
shadows. Shared chart, editor, and log classes consume these tokens rather than
literal product colors. Text/token contrast is checked at 4.5:1 or higher for
normal readable text, keyboard focus is visible, and status labels pair color
with text or an icon.

The blocking `/theme-prepaint.js` asset resolves authenticated account,
non-sensitive device hint, then system preference before application CSS is
painted. React continues from the same preference, follows live system changes
when `system` is selected, and switches Light/Dark without reloading state.
The active local account owns `preferred_theme`; browser storage is only a
pre-login hint.

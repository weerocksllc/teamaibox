# Precision Workspace UI

Approved design: [Team AI Box](https://www.figma.com/design/7hQqtwmQ8H9UWmn8Hvcnnu), foundations `15:7071` (light), `15:7131` (dark). Full page mapping is in `openspec/changes/archive/2026-10-22-redesign-premium-product-experience/design-review.md`.

This package owns appearance, not application state, permissions, requests, validation rules, storage, playback or device lifecycle.

## Entry points

- `src/tokens.css`: the existing 38 semantic preference tokens, spacing, typography, radii and compatibility aliases. Light/dark use the same names.
- `src/primitives.css`: native controls, visible focus, panels, status, field feedback and reduced motion.
- `src/components.tsx`: thin React Button, Panel, Status and Field. Values and submit callbacks stay with the caller. Busy buttons remain disabled; status text is supplied by the application.
- `src/preferences.css`: aliases for the existing `preferences-v1` snapshot. The SDK still validates origin, source and revision; CSS cannot grant access or change a session.
- `src/applications.css`: app-specific layouts for the nine standalone plugins. No guest-screen filters, cropping or theme rewriting.

React imports tokens/primitives before legacy styles, then `apps/web/src/precision.css`. Standalone HTML loads `ui-system.css` **last**. The existing static runtime concatenates these four CSS files once at process startup; the asset is served locally under each plugin path. No Google Fonts, CDN, external image or icon request is required. Font fallbacks cover offline Chinese and English environments.

For a static-only package, concatenate the same CSS into the plugin's public directory during its build. Rebuild the frontend or plugin artifact that carries the changed assets, and use the installation's supported deployment and rollback process. Historical single-installation rollout scripts and acceptance evidence are not part of this source release.

## Design mapping

| Figma concept | Implementation |
|---|---|
| Semantic light/dark variables | `--canvas`, `--surface*`, `--text*`, `--interactive*`, state colors |
| 4/8/12/16/24/32/48 spacing | `--space-*` |
| 8/12/16 radii, 44px controls | `--radius-*`, `--control-height`, `.ui-button` |
| Action variants and state | `Button`, `.ui-button--primary/secondary/quiet/danger`, native disabled/busy |
| Panel / badge / field | `Panel`, `Status`, `Field`, matching `.ui-*` classes |
| Icons | Existing local Lucide React; inline SVG paths in standalone markup |
| Modals, drawers, popovers | Existing `modal-focus.ts` and native `<dialog>`; do not replace domain handlers |
| Full application layouts | `applications.css` plus `apps/web/src/precision.css` |

## Integration rules

1. Do not key or reload an iframe when the theme/locale changes. Keep the preference bridge and application identifiers unchanged.
2. Keep DOM IDs and data attributes consumed by existing handlers. Restructure presentation without recreating a video, canvas, form or controller on preference changes.
3. Show service states received from existing APIs. Design sample numbers are never production fallback values.
4. Do not theme virtual Android/Windows content. Only the surrounding web controls follow the web preference.
5. Keep the native `hidden` attribute authoritative. Do not change required confirmations or disabled conditions to match a static mockup.
6. UI asset changes require rebuilding the frontend/plugin artifact that carries them, not recreating user devices or deploying business services.

## Local preview and bounded checks

`apps/web/tools/operations-preview-server.mjs` serves the built shell with explicitly synthetic data and a visible banner; `/ui-components` shows controls and confirmation focus behavior. It is not deployment or business acceptance evidence.

UI-only checks: `packages/ui-system/test/integration.test.mjs`, the existing web theme/preference tests, and the scoped `precision-*-browser.test.mjs` files. Browser checks default to skipped unless a local Playwright runtime is supplied. They abort non-local traffic and intercept writes. Do not use them as a reason to repeat accepted media/model/VM tests.

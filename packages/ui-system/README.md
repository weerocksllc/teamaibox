# Product workspace UI

Approved design: [Team AI Box](https://www.figma.com/design/7hQqtwmQ8H9UWmn8Hvcnnu), foundations `15:7071` (light), `15:7131` (dark). The source distribution does not depend on local OpenSpec planning files.

Focus Workspace design: page `151:7617`, overview `151:7618`, assistant `151:7619`, drawing `151:7620`, computers `151:7621`, phones `155:9875`. The light versions and empty/loading/error/laptop states are in the same Figma page. This is a presentation refresh, not a replacement for the product's catalog, routing or service contracts.

This package owns appearance, not application state, permissions, requests, validation rules, storage, playback or device lifecycle.

## Entry points

- `src/tokens.css`: the existing 38 semantic preference tokens, spacing, typography, radii and compatibility aliases. Light/dark use the same names.
- `src/primitives.css`: native controls, visible focus, panels, status, field feedback and reduced motion.
- `src/components.tsx`: thin React Button, Panel, Status and Field. Values and submit callbacks stay with the caller. Busy buttons remain disabled; status text is supplied by the application.
- `src/preferences.css`: aliases for the existing `preferences-v1` snapshot. The SDK still validates origin, source and revision; CSS cannot grant access or change a session.
- `src/applications.css`: app-specific layouts for the nine standalone plugins. No guest-screen filters, cropping or theme rewriting.

React imports tokens/primitives before legacy styles, then `apps/web/src/precision.css`, shared interiors, workspace compatibility styles and `focus-workspace.css`. Standalone HTML loads `ui-system.css` **last**. The static runtime concatenates tokens, primitives, preferences, application layouts and `premium-interiors.css` once at process startup; the asset is served locally under each plugin path. No Google Fonts, CDN, external image or icon request is required. Existing locale-specific font fallbacks remain intact.

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
7. Assistant history and transcript scroll independently. The composer stays outside both scrolling regions. Sources and outputs stay beside the response they belong to; do not add a duplicate result column that squeezes the conversation.
8. Drawing parameters scroll independently of the real form submit button. Errors remain readable in the parameter region; they must not push the pinned action out of view. Narrow screens use a single-column document layout.
9. Figma artwork, sample tasks and illustrated guest desktops are examples, not fallback product data. Without a real thumbnail API, use the real device name, state, specifications and existing launch controls, not a pretend desktop preview.
10. Reuse `AppearancePreferences` for toolbar and profile settings. Both operate the same existing preference handlers and iframe bridge; never remount a guest screen to change the surrounding theme or language.
11. A design-only action is not a product contract. In particular, assistant conversation deletion is not exposed as a decorative button when no corresponding API exists. Existing messaging deletion and virtual-device lifecycle controls are unchanged.
12. OCR, transcription and translation use `focus-tool-shell` / `focus-tool-layout`: parameters and results scroll separately on desktop, with the existing primary action in `focus-action-dock`. Narrow or very short windows return to a single-column document flow. ASR's dock visibility follows the existing `batch-controls[hidden]` state; changing tabs never starts a microphone or a job.
13. Management dialogs keep their native modality, busy/validation rules and caller-owned cancellation. Their heading and close control remain outside `precision-editor__body`, which owns long-form scrolling. Opening focuses the first existing field; closing restores the opener. Do not reimplement submission in a presentation wrapper.
14. The task drawer keeps its heading outside `drawer-content`. Status and guidance wrap instead of truncating; state colors, percentages and result links use the existing task response. Reading a failure never creates a retry. Dense management tables scroll inside their own containers on narrow screens.
15. Narrow layouts hide only the toolbar preference variant; language and appearance remain available in the profile menu. Global search fits the available viewport, keeps its input/close row outside result scrolling, and popovers scroll in short windows. These layouts do not replace the preference or search handlers.

The remaining application patterns use the original Figma screen contracts (OCR `6:929`, transcription `6:1048`, translation `6:1183`, messaging `8:1959`, drive `8:2095`) with the Focus semantic surfaces and typography. Original business controls not present in the illustrative screens remain available. Result content, file previews and job state still come only from the existing application APIs.

Management and task patterns reference overview `9:2135`, users `9:2303`, editing `12:5443`, tasks `11:4823`, failure `11:4966`, and audit detail `12:5833`. Overview metrics retain their real values, unsupported/missing markers and freshness; responsive cards change reading hierarchy only. Older frames include features removed from the product; they are not permission to restore those features or invent APIs for decorative controls.

## Local preview and bounded checks

`apps/web/tools/operations-preview-server.mjs` serves the built shell with explicitly synthetic data and a visible banner; `/ui-components` shows controls and confirmation focus behavior. It is not deployment or business acceptance evidence.

UI-only checks: `packages/ui-system/test/integration.test.mjs`, `packages/ui-system/test/focus-tool-layout.test.mjs`, `apps/web/test/focus-workspace.test.mjs`, the existing web theme/preference tests, and the scoped `precision-*-browser.test.mjs` files. The Focus checks cover scrolling/action regions, retained handler IDs, batch/live visibility, translated controls and closed conversation drawers. Browser checks default to skipped unless a local Playwright runtime is supplied. They abort non-local traffic and intercept writes. Do not use them as a reason to repeat accepted media/model/VM tests.

`apps/web/test/focus-operations-layout.test.mjs` guards the management/task presentation boundary. Set `TEAMAIBOX_PREVIEW_TASK_VARIANTS=1` on the loopback preview to add explicitly synthetic failed/cancelled/queued cards; normal fixture data is unchanged otherwise. `TEAMAIBOX_PREVIEW_DATA_STATE=empty|error` previews empty or unavailable feedback. These switches do not exist in the production UI.

`apps/web/test/focus-global-controls.test.mjs` guards narrow profile preferences and viewport-bounded search/popover layouts. Verify these with the local synthetic preview; no appliance or account changes are needed.

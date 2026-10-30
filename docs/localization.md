# Product interface localization

## Scope

The product interface supports 17 locales: Simplified Chinese, Traditional Chinese,
English, Japanese, Korean, French, German, Spanish, Brazilian Portuguese, Russian,
Arabic, Hindi, Indonesian, Italian, Turkish, Vietnamese and Thai.

This covers login, workbench, administration, the built-in assistant and all nine
official application frontends. It does not translate user messages, files, prompts,
model-generated answers, recognized/transcribed text, or Android/Windows guest
screens. Those are user content or independently configured guest systems.

## Sources and maintenance

- `packages/ui-system/src/locale-registry.mjs`: supported codes, native names,
  aliases and writing direction. Arabic uses RTL.
- Existing English and Simplified Chinese catalogs remain the source of truth.
- `packages/ui-system/src/locales/*.json`: prepared translations for the other
  15 locales. All are local files; using the interface requires no translation API.
- `locale-glossary.mjs`: curated product vocabulary, brand preservation and exact
  editorial corrections. Apply corrections here instead of hand-editing generated output.
- `global-translations.mjs`: generated runtime catalog.
- `product-localization.mjs`: translates only explicitly supplied product copy.
  It never scans and rewrites arbitrary user content.

Workflow for changed product copy:

```sh
node tools/localization-inventory.mjs
# Prepare missing entries in src/locales/<locale>.json, then assemble:
node tools/assemble-global-translations.mjs
node --test packages/ui-system/test/global-localization.test.mjs
pnpm --dir apps/web build
```

`prepare-public-ui-translations.mjs` is an optional, build-time draft preparation
tool. It sends only repository-owned interface strings to a translation service,
not user data, credentials or model output. The resulting files are checked in.
It is never loaded by the product. Translation drafts have received terminology
and representative-screen corrections, **not a native-speaker review of every
sentence in all 17 languages**. That distinction must remain visible in release
records; do not describe automated key parity as linguistic certification.

Do not silently add an untranslated choice to the language menu. Regenerate the
inventory and verify nonempty translations plus placeholder parity for every locale.
Preserve product names, protocol/format names, command syntax and IDs.

## Preferences and application integration

Language and theme use the same compact icon/dropdown controls before and after
sign-in. An explicit login-page choice is retained during interactive sign-in;
automatic session restoration still respects the stored account preference.
Changes propagate to application iframes without reopening a guest or restarting
a task. Cross-tab storage notifications refresh presentation only.

Migration 110 expands the existing account language constraint; it does not update
account rows. Its downgrade refuses to discard expanded-locale preferences.
The API publishes the released locale declaration for bundled official UI assets;
third-party plugin declarations and imported signed manifests are unchanged.

Use locale-aware `Intl` formatting for displayed numbers, dates, relative time,
units and language names. Keep protocol values and CSS dimensions ASCII. In
particular, localized percent text must not be assigned to `style.width`.

Result-label updates must not call a result renderer that replaces edited text.
OCR, transcription and translation refresh product labels independently of edits.

## Layout and visual language

`premium-interiors.css` supplies shared application surfaces, restrained teal/cyan
accents, focus rings, result cards, toolbars and dialogs. `premium-workspace.css`
extends these to the assistant and administration. Both themes use semantic tokens.
Direction-aware spacing uses logical CSS properties. Code and guest pixels remain
LTR-isolated; user content retains its own direction. Reduced-motion preferences
disable added transitions and animations.

Validate presentation using synthetic fixtures. Do not restart models or guests,
delete existing content, or repeat accepted business workflows for copy/style changes.

<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../../../README.md)
<!-- doc-navigation:end -->

# Public product screenshots

These are real Team AI Box workbench captures, one light and one dark image for
each of the 17 UI locales. They are product documentation assets, not the private
marketing website's source, templates or build output.

## Capture rules

- Use the actual product language and theme controls; do not translate labels
  onto an English screenshot or invent a successful result.
- Use a demonstration account and inspect every image for personal messages,
  file names, credentials, receiver PINs, network addresses and browser chrome.
  Never publish a signed-in guest disk or session/cookie export with images.
- Current workbench captures show only generic demonstration task status and
  the generic Administrator account. They do not expose task payloads.
- Keep product settings as they were after capture. Do not delete user data or
  rerun business workloads to obtain a screenshot.
- `workbench-light.jpg` and `workbench-dark.jpg` are the originals. Most use
  full-page capture. Arabic uses the actual viewport because the browser's
  full-page RTL capture displaced the page; no labels or results were altered.
- Some live task-status words are still English in otherwise localized views.
  These images intentionally preserve the shipped UI instead of retouching it.
  Guest operating systems, model responses and user-defined names have separate
  language settings and are not translated by the UI selector.

The README renderer requires both images for every product locale and fails
instead of silently falling back to an English screenshot. When refreshing the
UI, replace both themes and regenerate the image manifest with
`node tools/screenshot-manifest.mjs`. Keep network/device identifiers and local
capture logs out of this public directory.

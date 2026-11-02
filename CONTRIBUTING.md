<!-- doc-navigation:start -->
[English](CONTRIBUTING.md) · [简体中文](CONTRIBUTING.zh-CN.md) · [繁體中文](CONTRIBUTING.zh-TW.md) · [日本語](CONTRIBUTING.ja.md) · [한국어](CONTRIBUTING.ko.md) · [Français](CONTRIBUTING.fr.md) · [Deutsch](CONTRIBUTING.de.md) · [Español](CONTRIBUTING.es.md) · [Português](CONTRIBUTING.pt-BR.md) · [Русский](CONTRIBUTING.ru.md) · [العربية](CONTRIBUTING.ar.md) · [हिन्दी](CONTRIBUTING.hi.md) · [Bahasa Indonesia](CONTRIBUTING.id.md) · [Italiano](CONTRIBUTING.it.md) · [Türkçe](CONTRIBUTING.tr.md) · [Tiếng Việt](CONTRIBUTING.vi.md) · [ไทย](CONTRIBUTING.th.md)

[Team AI Box — README](README.md)
<!-- doc-navigation:end -->

# Contributing

Thanks for helping improve Team AI Box. We welcome first-time contributors:
bug reports, translations, documentation, accessibility, application integrations
and focused code changes all count. You do not need a DGX Spark to improve docs
or components that can be checked independently.

## From an idea to a pull request

1. Search [existing issues](https://github.com/weerocksllc/teamaibox/issues).
   Describe the user problem, expected behavior, actual behavior and relevant
   version. Discuss larger changes before investing in an implementation.
2. Fork the public repository and clone your fork. Create a focused branch;
   do not include the private marketing website, runtime data or downloaded models.
3. Follow [BUILDING](docs/open-source/BUILDING.md) for Node, pnpm and local
   component builds. The fresh-appliance installer is a different workflow:
   never run it on a machine containing business data just to develop the UI.
4. Make the smallest coherent change, update affected documentation and run
   relevant checks. Explain any hardware-dependent checks you could not run.
5. Open a pull request describing the problem, solution, compatibility impact
   and checks. Include sanitized screenshots for visible changes. Respond to
   review feedback; maintainers review before merging.

A local OpenSpec workspace is optional and is not published in this repository.
Public contributors can put a proposal and acceptance criteria directly in an
issue or PR; no missing private specification is required to participate.

## Translations and screenshots

For the detailed feature checklist, edit `docs/readme-features/<locale>.json`; keep group/item IDs and ordering aligned with English, and maintain the source references in `docs/readme-features/evidence.json`.

All 17 product languages have a README. Edit `docs/readme-locales/<locale>.json`,
then run `node tools/render-readmes.mjs` and
`node tools/render-readmes.mjs --check`. Do not hand-edit generated READMEs.
The locale list comes from `packages/ui-system/src/locale-registry.mjs`.
The linked installation, build, contribution, security and licensing guides use
the same 17 languages. Their document list is in `docs/document-locales/manifest.json`.
Edit the source-language page and paragraph translations in
`docs/document-locales/<locale>.json`, then run `node tools/render-documents.mjs`,
`node tools/render-readmes.mjs` and `node tools/check-document-locales.mjs`.
Translation keys are SHA-256 hashes of source paragraphs; a source change fails
the renderer until the corresponding translations are updated. Code examples
are shared verbatim, and document links are generated for the selected language.
New translations are machine-assisted drafts with protected code and links;
linguistic and terminology review is welcome. Generation and checks run locally,
without a translation service, API key or access to an appliance.
See [the screenshot policy](docs/assets/screenshots/README.md) before adding
public images. Translations, including terminology and natural phrasing, are
welcome review contributions.

## Contribution rules

- Original contributions are submitted under the repository's MIT license.
  Preserve third-party headers and state the source/license of copied material.
  No separate mandatory CLA or paid contributor permission is required.
- Use Node 24 and the pnpm version pinned in `package.json`. Python and Go
  requirements are described in [BUILDING](docs/open-source/BUILDING.md).
- Run only tests relevant to your change and report exactly what ran. A local
  fixture is not a claim of real device acceptance. Do not repeat or erase
  historical acceptance results merely to close a documentation change.
- Never test deletion, reinstallation or recovery against a user's data. Use
  synthetic fixtures or explicitly designated temporary resources.
- No private keys, tokens, cookies, customer prompts/files, signed-in guest
  images, private deployment snapshots or personal screenshots in issues/PRs.
  See [SECURITY](SECURITY.md) for private reporting.
- Keep `private: true` on workspace packages. Never rewrite shared Git history,
  move delivery tags or publish private build artifacts as part of a PR.

Document relevant tests, migrations and behavior changes in your contribution.
Hardware-dependent checks must identify the actual configuration and limits.

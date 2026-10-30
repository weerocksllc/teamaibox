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

All 17 product languages have a README. Edit `docs/readme-locales/<locale>.json`,
then run `node tools/render-readmes.mjs` and
`node tools/render-readmes.mjs --check`. Do not hand-edit generated READMEs.
The locale list comes from `packages/ui-system/src/locale-registry.mjs`.
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

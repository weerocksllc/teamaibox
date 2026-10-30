<!-- doc-navigation:start -->
[English](BUILDING.md) · [简体中文](BUILDING.zh-CN.md) · [繁體中文](BUILDING.zh-TW.md) · [日本語](BUILDING.ja.md) · [한국어](BUILDING.ko.md) · [Français](BUILDING.fr.md) · [Deutsch](BUILDING.de.md) · [Español](BUILDING.es.md) · [Português](BUILDING.pt-BR.md) · [Русский](BUILDING.ru.md) · [العربية](BUILDING.ar.md) · [हिन्दी](BUILDING.hi.md) · [Bahasa Indonesia](BUILDING.id.md) · [Italiano](BUILDING.it.md) · [Türkçe](BUILDING.tr.md) · [Tiếng Việt](BUILDING.vi.md) · [ไทย](BUILDING.th.md)

[Team AI Box — README](../../README.md)
<!-- doc-navigation:end -->

# Build the source

The public artifact is source, not a prebuilt offline appliance image. A source
build may download dependencies; installation using a prepared full package
remains offline. Neither process needs a ViKey SDK or a USB key.

For a complete appliance installation, start with the root
[quick start](../../README.md#install) and
[source installer](../../install/SOURCE-INSTALL.md):
`sudo bash install/from-source.sh` downloads, builds, packages and installs on
a compatible fresh Spark. The development web build below is not that installer
and does not start the complete product.

## Development

Use Node.js 24, pnpm 11.1.3 (see root `package.json`), Python 3.10+ and the Go
version declared in each `go.mod` (node-agent currently 1.26). On a build machine:

A source export deliberately has no private Git history. Before running source
tools on that exported tree, initialize your own repository and commit your
reviewed tree (`git init`, `git add .`, `git commit`). A normal public Git clone
does not need this step. Use that new commit as the build identity; do not claim
an exported, modified tree is the old delivery commit.

```sh
pnpm install --frozen-lockfile
pnpm --filter @teamaibox/web build
python3 tools/open_source_inventory.py --check
```

The web build is a compile check, not product acceptance. Runtime services use
the Dockerfiles under `deploy/`. DGX Spark execution requires Linux ARM64 and
the existing NVIDIA/Docker environment. A desktop source checkout is not a
replacement for that hardware. Do not use historical lab scripts as installers.

The Python factory build helpers additionally require PyYAML; see the installer
dependency preflight. No installed operating-system disk or developer account
is required.

## Excluded compiled inputs

The exporter omits binary files, even when their extension looks harmless:

- Build `services/node-agent` and its `cmd/factory-worker-spec` helper from Go
  source; the repository-root `node-agent` executable is not a source input.
- Android fixture APKs and signing files are not shipped. Their source and
  manifests under `tools/fixtures/` remain available for local test builds.
- The current appliance casting build uses
  `deploy/appliance/wireless-casting-plugin.Dockerfile`. It does not need the old
  Alpine package archives. If you use the standalone plugin Dockerfile instead,
  obtain the exact packages identified in
  [its upstream checksum manifest](../../apps/wireless-casting-plugin/vendor/alpine/security-update-20261010.json)
  and verify their SHA-256 values before building. Never substitute an arbitrary
  package when the pinned upstream artifact is unavailable.
- The LiveKit browser module and its license remain in the plugin's public
  source directory; the redundant npm `.tgz` archive is not shipped.

These are source-distribution exclusions, not changes to the running appliance.

## Complete offline package

Start with [the public source pipeline](../../install/PUBLIC-BUILD.md). It
supplies the public parent images and source-built runtime dependencies; a
previous developer installation is not required. Historical layered image
recipes are not the fresh-install entry point.

Follow [install/README.md](../../install/README.md) for application-image builds,
guest host tools, offline host packages, asset collection and final packing.
The target appliance does not fetch dependencies or replace Docker/NVIDIA.
Set build inputs to your actual source commit, ARM64 OCI content IDs and clean
asset paths. No development-host IP, account, certificate or volume is required.
Model weights and guest/runtime assets are obtained separately from the exact
upstream sources identified in [components.json](components.json) and the
repository locks. Preserve their licenses and required source notices.

**Source availability is not a binary redistribution clearance.** The current
complete offline-package contract includes a Google Android runtime; its
private installation evidence is not permission to distribute GMS. The existing
packager is retained unchanged, but such a package is not an approved public
download unless those rights are obtained. An AOSP-only public binary edition
would be a separately scoped packaging change, not silently substituted here.
Windows/Linux ISO files are provided by each user; no installed test guests or
account states are public build inputs.

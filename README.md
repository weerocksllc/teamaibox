<!-- Generated from docs/readme-locales/en.json by tools/render-readmes.mjs. -->
# Team AI Box

<p><img src="docs/assets/brand/mascot.png" alt="Team AI Box" width="160" height="160"></p>

**Powered by NVIDIA DGX Spark · MIT · Weerocks LLC**

[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

**Your DGX Spark. Your team's AI workspace.** Team AI Box turns one NVIDIA DGX Spark into a browser-based workspace for local AI, shared files, communication and virtual devices. It is built for teams that want to own their deployment and use the same tools from multiple computers, without installing a separate AI stack on every desk.

[teamaibox.com](https://teamaibox.com/) · [GitHub](https://github.com/weerocksllc/teamaibox) · [MIT](LICENSE) · [teamaibox@weerocks.llc](mailto:teamaibox@weerocks.llc)

## Why Team AI Box?

- **One appliance, one workspace.** AI tools, collaboration and virtual devices share a consistent interface and account system.
- **Local-first, not cloud-required.** Local model inference runs on your Spark. External model APIs are optional integrations; no USB hardware key is required.
- **Built for DGX Spark.** The installation pipeline targets Ubuntu ARM64, NVIDIA GPU containers and KVM virtualization instead of relying on a developer's machine.
- **Yours to improve.** Original code is MIT licensed. The interface supports 17 languages, light/dark themes and persistent manual language choices; English is the default.

## See the real workspace

Actual product capture in English, not a design mockup. The image follows GitHub's light/dark preference; both originals are linked below. Captures contain demonstration status only, not customer files or credentials. Some model output, guest operating systems and user-created names have their own language settings.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/screenshots/en/workbench-dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/screenshots/en/workbench-light.jpg">
  <img src="docs/assets/screenshots/en/workbench-light.jpg" alt="See the real workspace — English" width="1280">
</picture>

[Light screenshot](docs/assets/screenshots/en/workbench-light.jpg) · [Dark screenshot](docs/assets/screenshots/en/workbench-dark.jpg)

## What you can do

### AI assistant

Ask questions, draft and revise writing, summarize information and work with documents from one conversation interface. Local inference keeps the core workflow on the appliance; connect external providers only when you choose.

### AI drawing

Generate images from prompts, edit images and save results. Use it for visual exploration and content preparation; task status and outputs remain accessible in the workspace.

### Text recognition

Extract text and layout from images and documents, then review and reuse the recognized content rather than retyping it.

### Speech transcription

Turn audio or video into text with timestamps. Review recordings as searchable working material for meeting notes, subtitles and follow-up work.

### Translation

Translate text and supported files, with source/target languages drawn from the installed model's capabilities. Interface languages and model translation languages are separate lists.

### Messaging

Keep direct conversations and group discussions in the same workspace as team files. Manage messages and remove chats through visible controls.

### Team drive

Upload, organize, share and reuse team files. Choose existing files in supported application workflows instead of uploading the same material repeatedly.

### Wireless casting

Present from compatible Apple devices and watch in a browser, including sound. Colleagues on the appropriate network can join viewing; discovery depends on LAN connectivity.

### Virtual Android phones

Use persistent Android devices in a browser, install applications and return to your own device state. Each phone has its own apps and data; Google services remain subject to their own compatibility and licensing conditions.

### Virtual Windows and Linux computers

Upload an authorized ARM64 ISO or select one from team drive, mount the virtual optical drive and install through the virtual display. See boot and restart screens, use audio, invite viewers or controllers, hand off control or share control, and reclaim it as owner. Remote desktop is an additional mode, not a prerequisite for the display.

### Team administration and task visibility

Create ordinary accounts, manage access and see application readiness and task progress. An application becomes available when its own dependencies are ready; first model startup can take time.

## Install on a fresh DGX Spark

Use a **fresh DGX Spark with Ubuntu 24.04 ARM64**, working Docker Engine + Compose v2, NVIDIA drivers/container support, KVM, Git and Python 3.10+. Allow several hundred GB of temporary free space for models, container builds and the package. Do not run a fresh installation over existing business data.

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

Run these commands **on the Spark**, not on a desktop laptop. The installer downloads model/build inputs, builds runtime images, creates a complete offline package and installs it. This first source build requires internet access and substantial download/build time; clone alone does not install the product. Docker and the NVIDIA environment are reused, not replaced. No developer accounts, guest disks or credentials are copied.

### Preflight, download problems and resume

`--check` performs preflight. If interrupted, keep `/var/tmp/teamaibox-source-build` and rerun the **same command**: verified downloads and completed stages are reused. Do not start competing builds or delete the cache. Official sources are the default. Where upstream access is unavailable, use the documented alternate-source options or transfer a verified cache/complete offline package from a connected machine; no mirror guarantees availability. See [source installation](install/SOURCE-INSTALL.md) for logs, `--cache-dir`, `--work-dir` and recovery. A changed source tree needs a separate work directory, not a bypassed checkpoint.

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh
```

### After installation

1. Open `https://<BOX_LAN_IP>/` using the Spark's current LAN address. Verify that its locally generated HTTPS certificate belongs to your device.
2. Sign in as `admin` / `admin`, **change the initial password**, then create ordinary accounts. Do not expose the initial credentials to the public internet.
3. Wait for each AI application to become ready, select a language/theme in the profile menu and begin from the workbench. Readiness is recorded at `/srv/teamaibox/installation/readiness.json`.
4. For virtual computers, provide your own authorized Windows/Linux ARM64 ISO and OS license. For an offline target, first prepare the complete package, then follow [the package installation guide](install/README.md); source preparation itself is not offline.

## Open source, with clear boundaries

Original code and documentation are MIT licensed, **not every binary in an installation**. Third-party code, model weights, NVIDIA components, firmware, Google services and Windows retain their own terms. The repository does not ship model weights, installed Android/Windows disks, signed-in accounts, ISOs or offline packages. Google compatibility is not Play Protect certification; casting does not cover DRM-protected content or Apple certification. Windows 10 ARM64 is not claimed as supported. Performance and concurrency depend on workloads and hardware; no unlimited-capacity promise is made. The marketing website remains in a separate private repository; this public repository includes the product UI.

## Build it with us

We welcome bug reports, documentation, translations, accessibility improvements, application integrations and code. Start with an issue describing the user problem, fork the repository, create a focused branch and submit a pull request with relevant checks and screenshots. You do not need to own a Spark to improve docs or isolated components; label hardware-dependent results honestly. Never attach secrets, personal files or signed-in device images. Report vulnerabilities privately through SECURITY.md, not a public issue. No mandatory CLA or paid contributor permission is required.

[Issues](https://github.com/weerocksllc/teamaibox/issues) · [Pull requests](https://github.com/weerocksllc/teamaibox/pulls) · [CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md)

## Go deeper

- [Source installation, prerequisites and recovery](install/SOURCE-INSTALL.md)
- [Offline package building and installation](install/README.md)
- [Development environment and source build](docs/open-source/BUILDING.md)
- [Contribution workflow](CONTRIBUTING.md)
- [Private security reporting](SECURITY.md)
- [Third-party licenses and release scope](THIRD_PARTY_NOTICES.md)

`apps/` · `services/` · `packages/` · `install/` · `deploy/` · `docs/`

© 2026 Weerocks LLC. [MIT](LICENSE) · [Third-party licenses and release scope](docs/open-source/RELEASING.md)

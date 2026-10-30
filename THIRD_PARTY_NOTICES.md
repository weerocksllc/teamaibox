<!-- doc-navigation:start -->
[English](THIRD_PARTY_NOTICES.md) · [简体中文](THIRD_PARTY_NOTICES.zh-CN.md) · [繁體中文](THIRD_PARTY_NOTICES.zh-TW.md) · [日本語](THIRD_PARTY_NOTICES.ja.md) · [한국어](THIRD_PARTY_NOTICES.ko.md) · [Français](THIRD_PARTY_NOTICES.fr.md) · [Deutsch](THIRD_PARTY_NOTICES.de.md) · [Español](THIRD_PARTY_NOTICES.es.md) · [Português](THIRD_PARTY_NOTICES.pt-BR.md) · [Русский](THIRD_PARTY_NOTICES.ru.md) · [العربية](THIRD_PARTY_NOTICES.ar.md) · [हिन्दी](THIRD_PARTY_NOTICES.hi.md) · [Bahasa Indonesia](THIRD_PARTY_NOTICES.id.md) · [Italiano](THIRD_PARTY_NOTICES.it.md) · [Türkçe](THIRD_PARTY_NOTICES.tr.md) · [Tiếng Việt](THIRD_PARTY_NOTICES.vi.md) · [ไทย](THIRD_PARTY_NOTICES.th.md)

[Team AI Box — README](README.md)
<!-- doc-navigation:end -->

# License scope and third-party notices

Copyright © 2026 Weerocks LLC. The root [MIT license](LICENSE) covers the
original Team AI Box code and documentation authorized by its owner. It does
not relicense third-party code, copied/modified upstream files, dependencies,
models, firmware, operating systems, fonts or images. Existing copyright,
LICENSE and NOTICE files take precedence for their respective material.
Package metadata `license: MIT` refers to that package's original code, not
everything included in a deployed image. `private: true` is retained to avoid
accidental package-registry publication; it does not revoke the MIT grant.

## Inventory

The machine-readable [component inventory](docs/open-source/components.json)
records versions or version sources, licensing evidence, redistribution scope
and unresolved binary obligations. [Dependency inventory](docs/open-source/dependencies.json)
is generated from the lockfile, installed dependency metadata, Go modules and
Python requirement files. Missing license metadata is explicitly unknown, not
assumed MIT. Regenerate it with `python3 tools/open_source_inventory.py`.

| Component / material | License boundary | Distribution requirements |
| --- | --- | --- |
| UxPlay receiver and `deploy/casting/uxplay-*.patch` | GPL-3.0-only | Retain GPL, notices, exact upstream source, patches and build scripts with any receiver binary; merely linking to upstream is insufficient for a binary release. |
| gst-plugins-rs / `gst-webrtc-*.patch` | MPL-2.0 | Retain notices and make modified covered source files available. |
| GStreamer | LGPL and individual plugin licenses | Inspect the actual plugin set and fulfill corresponding obligations. |
| LiveKit server / browser SDK | Apache-2.0 | Retain copyright, license and applicable NOTICE. |
| Cuttlefish / AOSP | Apache-2.0 and per-file licenses, including GPL kernel | Preserve upstream notices and applicable corresponding source. AOSP does not include a Google services license. |
| QEMU / Linux / EDK II / virtio drivers | Per-project and per-file licenses | Audit the actual binary build, firmware and drivers; do not blanket-label MIT. |
| Guacamole | Apache-2.0 | Preserve the LICENSE and NOTICE copied by the computer-plugin Dockerfile. |
| Node / React / Vite and JS dependency tree | Per-package licenses | Preserve dependency notices when distributing bundled output. |
| PostgreSQL and container OS packages | PostgreSQL / per-package | Include installed-package license records in a binary release. |
| PyMuPDF / MuPDF used by OCR | AGPL-3.0-or-later or commercial license | The combined OCR worker distribution/service is not blanket MIT; comply with AGPL obligations or obtain commercial rights. Original code may retain its MIT grant. |
| Qwen / LMT / Whisper / FLUX model assets | Exact model's terms | Models are separate from the MIT source grant. FLUX **4B** terms must not be substituted for another FLUX model. |
| HunyuanOCR weights | Tencent Hunyuan Community License | Conditional model license; review recipient, territory, usage, attribution and redistribution terms for each release. |
| NVIDIA software | NVIDIA and included third-party terms | Existing host Docker/NVIDIA installation is not redistributed by this source package. Bundled CUDA/container libraries still need their own review. |
| Google Mobile Services / Play Store | Proprietary | Not part of the public source candidate. Runtime integration code does not grant rights to distribute GMS images. |
| Windows installation media, guest disks, accounts | Not covered | Users provide authorized ISO media and licenses. Never ship test VM disks or signed-in guest state. |
| Retired ViKey SDK | Proprietary / no public grant established | SDK removed from the working source; private historical commits and retained SDK copies must not be published. No USB key is required. |

Exact casting notices remain in [NOTICE.v4.txt](deploy/legal/airplay-compatible/NOTICE.v4.txt).
ADB transport notices remain beside the phone client. Do not remove them while
minifying or packaging. Container isolation by itself does not cancel copyleft
obligations. Distribution analysis depends on the actual combined artifact.

## Brand and contributors

MIT grants copyright permission, not trademark rights or endorsement. Team AI
Box and Weerocks names/logos must not imply official support for a modified
product. NVIDIA, DGX Spark, Android, Google Play, Windows and Apple/AirPlay
belong to their respective owners. Compatibility is not certification.

Local author metadata is an inventory, not proof of copyright assignment.
The reviewed ownership categories are recorded in
[OWNERSHIP.md](docs/open-source/OWNERSHIP.md).
The project owner's authorization applies to its original contributions;
contributors must submit only work they are entitled to license. Suspected
missing attribution: teamaibox@weerocks.llc.

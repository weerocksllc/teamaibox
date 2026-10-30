<!-- doc-navigation:start -->
[English](SOURCE-INSTALL.md) · [简体中文](SOURCE-INSTALL.zh-CN.md) · [繁體中文](SOURCE-INSTALL.zh-TW.md) · [日本語](SOURCE-INSTALL.ja.md) · [한국어](SOURCE-INSTALL.ko.md) · [Français](SOURCE-INSTALL.fr.md) · [Deutsch](SOURCE-INSTALL.de.md) · [Español](SOURCE-INSTALL.es.md) · [Português](SOURCE-INSTALL.pt-BR.md) · [Русский](SOURCE-INSTALL.ru.md) · [العربية](SOURCE-INSTALL.ar.md) · [हिन्दी](SOURCE-INSTALL.hi.md) · [Bahasa Indonesia](SOURCE-INSTALL.id.md) · [Italiano](SOURCE-INSTALL.it.md) · [Türkçe](SOURCE-INSTALL.tr.md) · [Tiếng Việt](SOURCE-INSTALL.vi.md) · [ไทย](SOURCE-INSTALL.th.md)

[Team AI Box — README](../README.md)
<!-- doc-navigation:end -->

# Install from a public clone

This entry point prepares the required public inputs, builds the application
images and produces a complete package before installing it. Build progress is
resumable; only the final installation readiness result indicates an installed
appliance. Download or preflight success alone does not.

Keep generated models, container images, installation packages, test records
and credentials outside the repository. Third-party mirror availability is not
guaranteed; verified portable caches and offline packages are described below.

On a fresh DGX Spark with Ubuntu 24.04, working Docker/Compose, NVIDIA and KVM,
clone the public repository and run from its root:

```sh
git clone https://github.com/weerocksllc/teamaibox.git
cd teamaibox
sudo bash install/from-source.sh
```

For a mainland China network where the upstream model/image endpoints cannot
be reached, use the same entry point with regional download sources:

```sh
sudo bash install/from-source.sh --region cn
```

This is an **online source build followed by offline installation**, not an
offline source build. It automatically prepares missing build tools, downloads
the six model inputs, builds and assembles Android and all application images,
quantizes the two source models, collects firmware/host packages, creates the
complete offline package and runs its existing installer. It does not replace
Docker/NVIDIA, restart the Docker daemon, clear an existing installation, or
change host routing, DNS or VPN settings. Models, guest login states and the
private marketing website are not taken from another installation.

The default workspace is `/var/tmp/teamaibox-source-build`; download caches and
per-stage logs live there, outside the clone. Installation defaults to
`/srv/teamaibox/installation`. Expect large downloads and several hundred GB of
temporary disk usage. Model loading and GPU quantization can take substantial
time; no fixed completion time is promised.

## Resume and status

If interrupted, **rerun the exact same command**. Keep the workspace. A running
build excludes another writer; completed stage files and images are verified
before reuse. Failed attempts remain available for diagnosis, while the next
attempt runs only the failed stage. Model byte ranges and verified files are
retained. `state.json` identifies the current stage and its log directory.
Official model downloads use bounded file/range concurrency; regional sources
use conservative concurrency to reduce rate limiting. Per-file byte progress
reports transferred or reused ranges separately from the final publisher hash
verification. Guest-tool compilation
also works under a system service with no login home: it creates isolated build
caches outside the resulting installation assets.

Source changes require a new `--work-dir`; reuse the download cache with
`--cache-dir /path/to/public-cache`. The source fingerprint prevents silently
combining outputs from different code. An existing installation is not an
invitation to reset it: only this workspace's same-package installation may
resume; other installs must use their upgrade process.

Useful modes:

```sh
sudo bash install/from-source.sh --check
sudo bash install/from-source.sh --region cn --download-models-only
sudo bash install/from-source.sh --region cn --build-only
```

`--check` is read-only and does not claim downloads will succeed. Download-only
and build-only explicitly do not claim installed readiness.

## Regional sources and integrity

China mode uses `https://hf-mirror.com` for model transfer and
`https://docker.m.daocloud.io` for digest-pinned Docker Hub inputs. These are
third-party mirrors, not services operated by Weerocks or the model publishers.
The model Git commit is pinned by the product profile; its verified Git tree
and LFS pointers establish the expected file sizes and hashes. The mirror's API
response alone cannot establish trust. Docker verifies pinned manifest/layer
digests. Unpinned tags are not automatically redirected (the Go build tool has
an explicit digest lock). NVIDIA images remain on their publisher's registry.
TLS verification stays enabled and no account tokens are sent to model mirrors.

You can select your own HTTPS origins using `--model-endpoint` and
`--registry-mirror`. Endpoint values must not include credentials or query
parameters. The scoped Docker wrapper applies only to this build process, not
the system daemon or other projects. SDK metadata and license archives still
come from their authoritative HTTPS publishers; a mirror cannot invent hashes.

Mirrors can be rate-limited or unavailable. Model downloads run with bounded
concurrency and respect cooldowns. No script can guarantee connectivity to every
upstream on every network. If both routes are unavailable, prepare downloads or
the complete package on an accessible compatible machine and copy them over:

- `--download-models-only --cache-dir <public-cache>` prepares verified model
  files and resumable caches. Copy that directory, then pass it with
  `--cache-dir` on the target. Every reused model is checked against its pinned
  identity. This cache is **not** a full offline installation package.
- `--build-only` prepares the full package for offline installation. Copy its
  tar and checksum, verify and unpack, then run `sudo ./install.sh` inside it.
  This is the reliable disconnected-host route; it does not require a VPN on
  the target or access to a development box.

Never copy a live Docker data directory, guest disks, browser profiles, account
databases, credentials or private caches as a substitute for public inputs.
Do not disable checksums or accept a login/challenge page as a model file.

## Licensing and first use

Review `THIRD_PARTY_NOTICES.md`, the Android SDK terms and individual model
licenses before building. Downloading third-party components does not turn
them into MIT assets or grant Google certification/redistribution rights.
Windows/Linux ISO media are still user-provided. The factory login remains
`admin/admin`; change it before exposing the appliance. The existing installer
generates independent service credentials and reports actual readiness.

After completion, open `https://<BOX_LAN_IP>/` on the same LAN; substitute the
Spark's current physical-network address, not a Docker bridge or VPN address.
The source workspace's `state.json` records build progress. The installed
`/srv/teamaibox/installation/readiness.json` records installation checks. Neither
a successful compilation nor a listening-container health check substitutes for
an application's visible end-to-end operation.

The casting runtime must contain the UxPlay receiver, private D-Bus and Avahi
discovery executables as well as its media plugins. The final public image build
checks these executables; a client library alone is insufficient. A fresh
installation registers the desktop proxy and gateway with the other API
network-namespace dependents so grouped API upgrades can retain the desktop
connection path. Do not recreate only a subset of that group during maintenance.

<!-- doc-navigation:start -->
[English](README.md) · [简体中文](README.zh-CN.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Français](README.fr.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Português](README.pt-BR.md) · [Русский](README.ru.md) · [العربية](README.ar.md) · [हिन्दी](README.hi.md) · [Bahasa Indonesia](README.id.md) · [Italiano](README.it.md) · [Türkçe](README.tr.md) · [Tiếng Việt](README.vi.md) · [ไทย](README.th.md)

[Team AI Box — README](../README.md)
<!-- doc-navigation:end -->

# Team AI Box offline package tools

The original installer is MIT-licensed. Packages include the root license,
third-party inventory and license texts in their file-hash inventory. This does
not relicense models, Google services, drivers or container dependencies as MIT.
Read the [release boundaries](../docs/open-source/RELEASING.md) before distribution;
an existing complete test package does not automatically have redistribution clearance.

Customers run **`sudo ./install.sh` inside the prepared package**. Maintainers
build that package with `build-package.sh`. Offline customers do not need Git,
Node, Go, pip or public package repositories.

For automatic downloading, building and installation from a public clone, run
`sudo bash install/from-source.sh`. Networks in China can use `--region cn`.
See [SOURCE-INSTALL.md](SOURCE-INSTALL.md) for operation, resuming and offline
transfer. Resume is supported; only the final readiness result establishes
installation completion. A successful preflight or download is not sufficient.

The target is a fresh DGX Spark with its factory Ubuntu 24.04 ARM64 system and
working Docker Engine, Compose v2, NVIDIA Container Toolkit/GPU and KVM.
The installer does not replace Docker/NVIDIA, restart Docker, or copy a
development appliance's accounts, database, keys or virtual machines.

> Private installation acceptance records stay in the historical development
> repository. They are neither public source files nor build inputs. Existing
> first-install, resume and boot-recovery evidence is not rerun merely for source
> publication, and does not qualify arbitrary newly built images or grant
> redistribution rights for third-party binaries.

## Maintainers: prepare release inputs

**For a fresh public GitHub build, start with [PUBLIC-BUILD.md](PUBLIC-BUILD.md).**
It covers public images, camera runtimes, model downloads/quantization and
firmware without requiring images from a development appliance. The layered
image helpers below support incremental updates of verified artifacts; they
are not prerequisites for a fresh build.

Preparation may use the internet. Installation from the delivered package must
not download dependencies. The packaging host needs Python 3.10+, PyYAML, Git,
Docker, `dpkg-deb` and sufficient storage. Models and images can be large; the
packager retains both the extracted tree and `.tar`, estimating space from
actual inputs. It neither scans a whole development appliance nor exports
writable layers from running containers.

1. Prepare ARM64 images from **one release version** for all required roles.
   Use the build entry points under `deploy/images/`, `deploy/appliance/` and
   the corresponding guest/model directories. Platform API, Node Agent,
   scheduler and agent controller must support local image IDs; the PostgreSQL
   image must contain the current migration manifest, including migration 116.
   The packager does not compile an arbitrary old image into a current one.
   With verified same-version parent images, use
   `build_runtime_images.py --bases … --node-agent-binary … --output …`
   to build the five successor images. `--bases` is a JSON role-to-full-image-ID
   map. First build Node Agent with `GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build`.
   This helper forbids pulls/network builds, records parent/source identities,
   and creates new images without deploying or changing live tags.
   Clean Android ROMs also need the current control-network adapter. Use
   `build_phone_images.py --bases <phone-role-image-ids.json> --output <new-directory>`
   to add `phone_network.py` to both ROM successor layers without network access
   or ROM-data changes. It records exact image IDs and source digests. Bind the
   Android sidecar to both new IDs, not the previous ones.
   Build the web and nine official apps using
   `build_application_images.py --node-base <clean-arm64-node-image-id> --guacamole-image <offline-guacamole-image-id> --output <new-directory>`.
   First build the web as specified by `apps/web/package.json`. The helper uses
   production Dockerfiles, fixes the web directory at `/opt/teamaibox/web`, and
   compares image files against current build-input hashes. Do not assume a
   development container image is a complete web build: it may depend on extra
   static-directory variables or contain an old directory. This offline helper
   does not deploy. Put all ten new image IDs into the release inputs.
2. Collect complete, clean directories for six models: configuration, shards,
   tokenizers, required code and licenses. Also prepare two clean Android images,
   UEFI `CODE.fd`/`VARS.fd`, `virtio.iso` and the drawing runtime scripts.
   Do not collect phone instance directories, user disks, Google login state,
   user ISOs or global credentials. Android ROMs are already inside
   `phone-runtime` / `phone-google-runtime`; do not copy a second disk.
   The `android-standard` / `android-google` asset directories contain only
   provenance, licenses and `manifest.json`: `schemaVersion: 1`,
   `androidVersion: "17"`, `baseBuildId: "16102939"`, `systemFamily: "standard"`
   or `"google-play"`, and `runtimeImageId: "sha256:…"`.
   The ID must match the exported runtime image. The driver directory contains
   only `virtio.iso`; a development directory also containing `windows.iso`
   is rejected.
3. Build the two bundled Linux ARM64 host tools without installing them on the
   build host:

   ```sh
   python3 install/build_guest_tools.py --output /build/artifacts/guest-host-tools
   ```

4. On an internet-connected ARM64 build host, collect host-tool dependencies
   using an explicit local Ubuntu 24.04 image. Use the image ID verified on that
   host, not an ID copied from a development appliance:

   ```sh
   python3 install/collect_host_packages.py \
     --base-image "$UBUNTU_ARM64_IMAGE_ID" --output /build/artifacts/host-packages
   ```

   Collect only dependencies for cryptsetup, ext4, USB/cameras, QEMU image tools,
   networking and small system utilities. Docker, containerd, NVIDIA, CUDA and
   kernel replacement packages are prohibited. Installation supplies missing
   tools only; apt reads the package's local file repository with
   `--no-download --no-remove`, without an online fallback.

5. Generate the release-input manifest and supply **explicit artifact paths and
   local image content IDs**:

   ```sh
   python3 install/prepare-release.py --template /build/artifact-inputs.json
   python3 install/prepare-release.py --inputs /build/artifact-inputs.json \
     --output /build/prepared-release
   ```

   The template includes all 41 image roles and 12 external asset categories;
   another factory asset is generated by the tools. Placeholders cannot enter
   a package. `sourceCommit` must match the checkout, `agentVersion` the actual
   Agent build, and `hostPackageCollection` the step-4 `collection.json`.
   Build-host paths are collection inputs, not customer runtime configuration.
   Use the current factory generator: the drawing UI's `drawing.automatic` /
   `drawing.fast` routes must match the local model configuration. Worker health
   or a direct model call alone does not establish application readiness.
   Packaging rejects stale factory templates missing these mappings.

The image-role contract is reported by `python3 install/package.py --describe-contract`:

- Core, web, team drive, messaging, gateways, scheduler, maintenance, plugins,
  dynamic agent sandboxes and package-source gateways.
- Nine application plugins, six office model workers and on-demand ASR/speaker runtimes.
- Standard Android, Google Android, computer runtime and web display/audio gateways.
- Casting receiver, media processing and SFU.

Two roles may share one image content ID; its archive is exported only once.
Model shard indexes are checked too: matching file hashes do not excuse a
missing shard. Host tools must be actual ARM64 ELF binaries.

## Build the package

```sh
./install/build-package.sh --release /build/prepared-release/release-input.json \
  --output /build/output
```

Outputs are `teamaibox-<releaseId>-linux-arm64.tar`, its `.sha256` file and the
extracted directory. Copying, image export, hashing and archiving occur in a
temporary directory before the final checksum is published. Existing outputs
are not overwritten; an interrupted build must not look like a complete release.
For installer-only changes with unchanged image identities, use
`--image-cache <previous-extracted-package>`. The entire old package is verified
before its archives are reused by actual image ID, and the new package is
verified again. No data is taken from an old installation or container writable
layer. This avoids exporting hundreds of GB of identical images again.

A normal release requires its bundled source files to belong to the declared
Git commit. An explicit `--allow-working-tree` creates a development candidate;
its manifest records `candidate: true` and changed files. Passing focused
acceptance does not turn uncommitted source into a published release.

Package layout:

```text
teamaibox-<releaseId>-linux-arm64/
  install.sh, installer.py, offline_common.py, offline_host_packages.py
  README.zh-CN.md, release.json, checksums.sha256
  images/          # Docker archives deduplicated by content ID
  assets/          # Models, Android, computers, tools and factory configuration by role
  host-packages/   # Complete .deb dependency set
  runtime/         # Installer adapters and recovery-tool module closure
```

Verify independently with
`./install/build-package.sh --verify /build/output/teamaibox-<releaseId>-linux-arm64`.
This checks integrity; it does not prove a successful boot on new hardware.

## Customers: offline installation and resume

Read the [package installation guide](PACKAGE-README.en.md). The default root is
`/srv/teamaibox/installation`. LUKS/ext4 is created only inside the new
`volume/data.img`, not on the system disk or existing disks. The data pool uses
available storage minus a physical safety margin, not a fixed 256 GiB limit.
Models, business files and guest data reside in the encrypted volume; existing
Docker manages container images.

A fresh installation creates administrator `admin` with initial password `admin`.
Ordinary users are created by the administrator. Change the initial password
before delivery/use. This applies only to an empty account database: resume,
rerun, reboot and upgrade do not reset existing accounts or passwords. Device
identity, service credentials, certificates and administrator recovery codes
are independently generated, not copied from another appliance.
Initial GPU kernel-cache preparation runs on the appliance using bundled tools
and models; compatible caches are retained. Boot recovery restores data and
device services first, then core services and individual AI workers. The
installer runs during installation only; it adds no resident installer manager.

After interruption, repeat the original command. Completed steps are verified;
do not hide conflicts by deleting data or recreating containers. Rerunning a
completed same-version installation only checks it; different versions use the
formal upgrade path. Failure details are in `install-state.json`,
`readiness.json` and stage records under the installation root.

## Verification boundaries

Installer-specific tests use small structural artifacts, temporary files and
isolated offline databases/Docker daemons. They must not access business
databases or mount existing VM disks. A real fresh installation requires a
compatible DGX Spark explicitly designated for that purpose; do not erase a
business appliance. Acceptance covers minimum startup, resume and boot recovery
for the new installation, not unrelated business tests. Source-release
preparation itself does not erase, reinstall or deploy existing appliances.

On a build host, run
`sudo python3 install/verify_bundle_offline.py --package <extracted-package> --output <new-test-directory>`
to import the full package into a separate Docker daemon with an empty cache
and no public network. It does not invoke the fresh-install script, use a GPU,
mount customer directories or restart system Docker. Its report explicitly
does not claim full hardware installation. Test images remain in the dedicated
test directory, need additional disk space and do not enter system Docker's
image store.

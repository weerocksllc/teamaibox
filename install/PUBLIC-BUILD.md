# Build an appliance from the public source

The new orchestration entry point is documented in
[SOURCE-INSTALL.md](SOURCE-INSTALL.md). It automates the recipes below; its
full-appliance verification status is stated there. These manual recipes remain
available for maintainers and individual stage diagnosis.

This is the source-to-package path. It does not import a previous Team AI Box
installation, its containers, accounts, certificates, guests or database. The
build machine needs internet access; the resulting complete package installs
offline. The customer supplies Windows/Linux installation media separately.

Use Linux ARM64 (Ubuntu 24.04), Docker/BuildKit, Python 3.10+, PyYAML, jq, Git,
Go 1.26 and enough disk space for source downloads, build layers and the final
uncompressed bundle. Model quantization also requires a compatible NVIDIA GPU
with sufficient free memory. Do not stop other workloads to obtain that memory
without the machine owner's permission. Docker and NVIDIA are prerequisites,
not components replaced by the installer.

Run commands from a fresh public checkout. Set `BUILD` to a new, absolute build
directory **outside** the checkout. Outputs, models and reports must not be
committed. Every helper refuses an occupied output unless it documents a
specific resume operation. Use the successful report's references/IDs, not
image names copied from someone else's machine. A local Docker content ID is
not a downloadable registry reference; Dockerfile parent arguments need the
corresponding local tag or a qualified upstream digest.

## 1. Services and applications

```sh
python3 install/build_public_services.py --output "$BUILD/services" \
  --network host \
  --guacamole-image docker.io/guacamole/guacamole@sha256:f344085e618bb05e22b964b0208dbd06d3468275bac70206f93805245e067b40 \
  --guacd-image docker.io/guacamole/guacd@sha256:8974eaa9ba32f713daf311e7cc8cd7e4cdfba1edea39eed75524e78ef4b08f4f \
  --roles platform-api web postgres event-bus node-agent agent-bridge \
  object-service messaging scheduler plugin-runtime observability \
  compute-gateway appliance-gateway maintenance-controller source-gateway \
  agent-sandbox computer-runtime desktop-gateway desktop-proxy \
  casting-receiver casting-media assistant-worker embedding-worker \
  translation-worker drawing-worker ocr-worker asr-worker batch-asr-worker \
  speaker-diarization-worker messaging-plugin team-drive-plugin drawing-plugin \
  ocr-plugin asr-plugin translation-plugin virtual-phones-plugin \
  virtual-computers-plugin wireless-casting-plugin

python3 install/build_public_sfu.py \
  --cache "$BUILD/downloads" --output "$BUILD/sfu"
```

`--network host` affects online **builds**, not installed service networking.
Node dependency stages allow 2 seconds per connection attempt instead of the
Node default of 250 ms. This keeps official npm downloads usable on higher-latency
links, including user-managed VPNs, without switching registries, disabling IPv6
or weakening TLS/package integrity checks. The setting is a build-stage argument,
not an environment change in the installed application. For a slower link, direct
Docker builds can override
`--build-arg NODE_OPTIONS=--network-family-autoselection-attempt-timeout=5000`.
The web image builds its own locked dependencies and assets. Node services
share the newly built API dependency closure. OCR includes its public adapter;
it does not need an unpublished worker package from another project.
Translation uses the pinned public NVIDIA vLLM image. Embedding, batch ASR and
casting media deliberately share their respective public runtime images.
The computer image builds signature-verified QEMU 11.1.1 with ARM TPM/PPI,
KVM, VNC and PulseAudio support, preserving the original Windows runtime's
capabilities. Debian supplies runtime libraries, but its older packaged QEMU
must not replace this executable. The final image checks both the ARM TIS `ppi`
property and PulseAudio backend and includes the matching RAM framebuffer ROM.
See `deploy/windows-computer/README.md` for the bounded runtime probe and
data-preserving update requirements.

Each role has a log. A failed report preserves successful role outputs; build
only the failed role and merge the successful reports later. Do not substitute
a running development container as a missing image.

## 2. Account-free Android and camera runtime

The locks pin Google's AOSP build, host package, kernel inputs and source
revisions. Downloads are checked before use. No guest is booted during assembly.

```sh
python3 install/build_public_android.py --cache "$BUILD/android-downloads" \
  --output "$BUILD/android"
PHONE_BASE=$(jq -r '.images.network.reference' "$BUILD/android/build.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_BASE" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:phone-tools deploy/android/cuttlefish

python3 install/build_public_camera_backend.py --cache "$BUILD/camera-downloads" \
  --output "$BUILD/camera-backend"
CAMERA_COMPILER=$(jq -r '.compiler' "$BUILD/camera-backend/build.json")
python3 install/fetch_public_camera_kernel.py --output "$BUILD/kernel"
python3 tools/prepare_phone_camera_guest_driver.py --output "$BUILD/guest-source"
python3 tools/build_phone_camera_guest_driver.py --inputs "$BUILD/kernel" \
  --source "$BUILD/guest-source" --compiler-image "$CAMERA_COMPILER" \
  --output "$BUILD/guest-driver"
```

For the camera APK patch, install Google's public Android command-line tools,
platform `android-36.1`, build-tools `36.1.0`, and a JDK supporting Java release
8. Set `ANDROID_SDK_ROOT` and `JDK_HOME` to those tool directories. The tools
are build dependencies, not exported Android user profiles. On ARM64 Linux,
Google's bundled `zipalign` may be x86-only: install Ubuntu's ARM64 `zipalign`
package and pass `--zipalign /usr/bin/zipalign` below. D8 and apksigner are Java
programs. The APK build can alternatively run on a separate supported SDK host;
transfer only its two output files (`Camera2.apk`, `camera-preview.json`), never
that host's Android settings or user profile.

Extract the stock APK from the clean AOSP build (the output directory must
exist and be writable by the build container):

```sh
mkdir "$BUILD/stock-camera"
docker run --rm --network none --read-only --user 0:0 --tmpfs /tmp:size=2g \
  --entrypoint python3 \
  --mount "type=bind,src=$PWD/deploy/android/cuttlefish,dst=/build,readonly" \
  --mount "type=bind,src=$BUILD/stock-camera,dst=/work" \
  teamaibox-build:phone-tools /build/prepare_camera_rom_inputs.py
python3 install/build_public_camera_apk.py \
  --stock "$BUILD/stock-camera/inputs/stock-Camera2.apk" \
  --sdk "$ANDROID_SDK_ROOT" --java-home "$JDK_HOME" --output "$BUILD/camera-apk"
python3 install/build_public_phone_rom.py --base-image "$PHONE_BASE" \
  --tools-image teamaibox-build:phone-tools --apk "$BUILD/camera-apk" \
  --module "$BUILD/guest-driver" --output "$BUILD/camera-rom"
PHONE_PARTITIONS=$(jq -r '.reference' "$BUILD/camera-rom/build.json")
python3 install/build_public_phone_runtime.py --base-image "$PHONE_PARTITIONS" \
  --backend "$BUILD/camera-backend" --cache "$BUILD/camera-downloads" \
  --output "$BUILD/phone"
```

The APK keeps the known **public AOSP test signer**, not a private product key.
The helper verifies the original and resulting certificate and unchanged APK
resources, and removes temporary signing material. This is not an account or
Google device identity.

The current complete installer contract also includes an experimental Google
Android variant. Its public input lock and signature inspection do **not**
grant Google certification or redistribution rights. Build/use it only within
the applicable third-party terms; do not publish the resulting full bundle as
an unrestricted MIT download.

```sh
PHONE_RUNTIME=$(jq -r '.references["phone-runtime"]' "$BUILD/phone/images.json")
docker build --network host --build-arg PHONE_BASE_IMAGE="$PHONE_RUNTIME" \
  -f deploy/android/cuttlefish/GappsTools.Dockerfile \
  -t teamaibox-build:google-tools deploy/android/cuttlefish
python3 install/inspect_public_phone_inputs.py --cache "$BUILD/google-downloads" \
  --tools-image teamaibox-build:google-tools --output "$BUILD/google-inputs"
python3 install/build_public_google_phone.py --base-image "$PHONE_RUNTIME" \
  --tools-image teamaibox-build:google-tools --inspection "$BUILD/google-inputs" \
  --output "$BUILD/google-phone"
```

## 3. Publisher model files and public quantization recipe

```sh
for role in embedding-model drawing-model ocr-model asr-model; do
  python3 install/fetch_public_models.py --role "$role" \
    --output "$BUILD/assets/$role"
done
for role in assistant translation; do
  python3 install/fetch_public_models.py --role "$role-source" \
    --output "$BUILD/model-sources/$role"
done
OFFICE_ENGINE=$(jq -r '.references["assistant-worker"]' "$BUILD/services/images.json")
docker build --network host --build-arg OFFICE_ENGINE_IMAGE="$OFFICE_ENGINE" \
  -f deploy/compute/qwen38-modelopt/Dockerfile \
  -t teamaibox-build:modelopt deploy/compute/qwen38-modelopt
for role in assistant translation; do
  python3 install/prepare_public_quantized.py --role "$role" \
    --source "$BUILD/model-sources/$role" --tools-image teamaibox-build:modelopt \
    --output "$BUILD/quantized/$role"
done
```

All model downloads use the immutable revisions in `deploy/compute/*profile*`
and the publisher's Git/LFS hashes. Optional `--cache <directory>` is read-only
and accepts files only when their bytes match the publisher. It is not a way
to import an installed model directory indiscriminately. ASR's standalone MIT
text is pinned to the original Whisper release because the converted model
snapshot only declares the license. OCR retains its own license, not MIT.
The pinned translation and embedding model cards declare Apache-2.0 without
shipping its standalone text; their helpers include the checksum-pinned Apache
license and a provenance record after checking that declaration.

An interrupted matching download supports `--resume`. `--transfer ranges`
uses bounded resumable HTTP ranges; `--transfer huggingface` requires the
official `huggingface_hub`/`hf_xet` packages and disables token use. Partials and
download caches remain outside publishable model directories. Checksums are
mandatory with every transport. Do not weaken them for HTML login/challenge
pages or truncated downloads.

Quantization runs offline in a separate build container using ModelOpt's public
synthetic calibration data, never chat histories. Only outputs whose
`build.json` says `quantized` can supply `assistant-model` and
`translation-model`; select their `model/` subdirectories, not raw sources or
the entire build workspace.
After validating inputs, Linux builds advise the kernel to release those
specific files' cached pages. This avoids misleading immediately-free GPU
memory readings on GB10's shared memory; it does not delete weights, clear
host-wide caches, or stop workloads.
For one GB10 GPU, the helper budgets from Linux `MemAvailable` and reserves
capacity for calibration and the host. It refuses insufficient capacity rather
than silently accepting a mostly-CPU build. When the full model fits, explicit
ModelOpt budgets avoid Accelerate's unnecessary CPU-offload export path.
The build container also sets unlimited locked memory and a 64 MiB stack,
following [NVIDIA's quantization launch requirements](https://build.nvidia.com/spark/nvfp4-quantization/instructions).
These settings are scoped to the build container, not host-wide limits.

## 4. Complete package inputs

```sh
python3 install/merge_public_images.py --report "$BUILD/services/images.json" \
  --report "$BUILD/sfu/images.json" --report "$BUILD/phone/images.json" \
  --report "$BUILD/google-phone/images.json" --output "$BUILD/images.json"
python3 install/prepare_public_resources.py --images "$BUILD/images.json" \
  --driver-cache "$BUILD/downloads/virtio-win-0.1.285.iso" \
  --output "$BUILD/resources"
python3 install/build_guest_tools.py --output "$BUILD/guest-tools"
```

The merger must report **41 roles and no missing roles**. It verifies image
architecture/content IDs and rejects conflicting outputs. Resources contain
only upstream UEFI firmware (including a fresh variable-store template), a
checksum-pinned virtio driver ISO, source drawing runtime and Android notices
bound to the newly built images. The ISO is not Windows installation media.
Its checksum-identical Microsoft OpenVMM mirror avoids relying on an
interactive Fedora download page.

Collect host packages with `collect_host_packages.py` as described in
[README.md](README.md), then generate the template with
`prepare-release.py --template`. Fill its image map from `images.json`; fill
all 12 asset roles from the model outputs, `resources/assets.json` and
`guest-tools`. Set `sourceCommit` to the checkout and the actual agent version.
No placeholder or previous installation configuration is acceptable.

Run `prepare-release.py --inputs … --output …`, then `build-package.sh` using
that prepared release. Modified/uncommitted sources require the explicit
`--allow-working-tree` candidate flag; they are not a released commit.
See [PACKAGE-README.md](PACKAGE-README.md) for installation. A new blank account
database gets `admin/admin`; all service credentials and device identity are
generated independently. Builds alone do not prove installation succeeded.

## Historical layered recipes and publication checks

Older diagnostic/layered Dockerfiles are retained for source maintenance, not
used by this pipeline. Their `BUILD_PARENT_N` arguments intentionally have no
private image default. Supply a compatible parent you built, or use the public
pipeline above; do not guess an unavailable development digest.

Before publishing, run the source guard and secret scanner, review history
separately, and exclude all build directories, packages, guest disks, account
data and the private website. Reports containing local paths belong outside
the public tree. Verification for this work is limited to build input closure,
artifact identity, installation and the newly installed minimum service paths;
it does not rerun unrelated business acceptance.

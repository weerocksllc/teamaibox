# Trusted Media Open-Source Build v2

This is the corresponding-source and build recipe for the ARM64 Team AI Box
trusted media service. It produces an AirPlay-compatible receiver and does not
claim Apple or MFi certification. FairPlay/DRM-protected content is unsupported.

## Exact receiver source

- Repository: `https://github.com/FDH2/UxPlay`
- Version: `1.73.6`
- Commit: `21eef8df25d91e12635c36d8176ad192725baca2`
- Commit archive: `https://github.com/FDH2/UxPlay/archive/21eef8df25d91e12635c36d8176ad192725baca2.tar.gz`
- Archive SHA-256: `03a92523cf750af87be594974819cd6709c5e7a6f8863f109b418b246acf9c5c`
- License: `GPL-3.0-only`; bundled license and authorship files are retained by
  the build.

The Dockerfile downloads this exact archive and aborts before extraction if
the SHA-256 differs. Team AI Box applies no source patch in v2. Its additions
are the open Dockerfile, fixed supervisor, health probe, runtime policy and
NOTICE stored in this repository.

## ARM64 build

From the repository root on an ARM64 Docker host:

```sh
docker build --platform linux/arm64/v8 \
  --file deploy/casting/TrustedMediaService.arm64.v2.Dockerfile \
  --tag teamaibox/trusted-media-service:open-source-v2 .
```

The base is Ubuntu 24.04 ARM64 manifest
`sha256:95fa486768020359141f1318720f43e7982ef926c792891d984aef9aaf05e7ea`.
Direct build/runtime package versions are fixed in the Dockerfile. Transitive
package identities are captured by the final image SPDX SBOM rather than by a
second private source mirror.

GStreamer, its WebRTC elements and the FFmpeg-backed H.264/AAC/ALAC decoders
are consumed as exact Ubuntu source-package revisions through the versioned
ARM64 binary packages in `airplay-compatible-stack.lock.v2.json`. Their final
installed bytes are covered by the signed OCI content digest and their package
and license identities are enumerated in the SPDX SBOM. The separate LiveKit
SFU source commit/archive SHA-256, ARM64 image digest and browser SDK tarball
SHA-256 are fixed in the same public lock. This is the open-source release
boundary; a duplicate private mirror is not required.

## Release checks

The checked-in release runner performs one ARM64 build, records the OCI image
digest, generates SPDX JSON, scans the final image and fails on any unaccepted
Critical finding, then verifies the normal Team AI Box signature. A private
source mirror, AirPlay-specific SLSA statement, duplicate CycloneDX SBOM and a
second byte-identical build are optional, not release gates.

Actual receiver activation additionally requires the hardware, security,
sender, HDMI and browser acceptance tasks in OpenSpec 22.2–22.15. Passing this
source/build minimum alone must not advertise a receiver.

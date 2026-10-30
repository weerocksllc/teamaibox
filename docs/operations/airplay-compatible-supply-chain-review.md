# AirPlay-compatible receiver supply-chain and legal review

This packet records an exact **source candidate** for OpenSpec 22.1. It does not approve a release, does not authorize deployment, and is not legal advice. The machine-readable lock is `deploy/casting/airplay-compatible-stack.lock.json`; its `releaseEligible` and `task22_1Complete` fields intentionally remain false.

## Decision summary

- Receiver candidate: UxPlay `v1.73.6`, commit `21eef8df25d91e12635c36d8176ad192725baca2`, tree `ece31de373433cf042ecb3ab801abb6ceb23fba3`.
- Media framework: GStreamer `1.28.6`, commit `2d3e05cbdad68e47d645f548899b432dc9fb4473`.
- Browser producer: the MPL-2.0 `gst-plugin-webrtc` crate from `gst-plugins-rs` tag `gstreamer-1.28.6`, commit `75e46c3a1b868e9a08fd688d091476b76a498df1`, built with default features off and only `livekit` enabled.
- SFU: LiveKit Server `v1.13.6`, commit `3cfbd1242618a61178f7a05b126d6c0c4cac3731`; candidate Linux ARM64 manifest `sha256:4eeb7a7af9e133afee7d07fc48623373852a34ad709094345d1761c9b283dc1a`.
- Browser viewer SDK: Apache-2.0 `livekit-client` `v2.21.0`, commit `15ca5f8180ab8939c3a5a4dfee1d5e44f62f71cf`. The source candidate records the annotated tag object, npm SHA-1/integrity string, observed npm signature and provenance metadata; the controlled tarball SHA-256 and transitive browser bundle remain unverified and release-blocking.
- AirPlay-compatible ingress: H.264 video plus AAC/ALAC audio decoding. Browser egress candidate: one VP8/Opus publisher encode sent to the internal LiveKit SFU, which fans out to at most eight viewers.
- H.264 browser encoding, HEVC, HLS, recording, `gst-plugins-ugly`, x264/x265, OpenH264, FDK AAC, FFmpeg GPL/nonfree mode, and the unused gst-plugin-webrtc signallers are excluded.
- UxPlay is kept in the trusted media-service boundary. LiveKit is a separate, internal SFU process; the browser never talks directly to UxPlay.

This selection is deliberately narrow. Upstream explains that ordinary `webrtcsink` creates a separate encoder pipeline for each consumer and does not share encoding. The `livekitwebrtcsink` candidate instead publishes one encoded stream to an SFU. The one-encode property, 1080p30 behavior and eight-viewer ceiling still require real ARM64 validation; this review does not treat upstream architecture as product evidence.

## Primary upstream sources

The review was refreshed on 2026-09-04 from upstream project or vendor sources:

- [UxPlay pinned source and README](https://github.com/FDH2/UxPlay/tree/21eef8df25d91e12635c36d8176ad192725baca2), [UxPlay GPLv3 license](https://github.com/FDH2/UxPlay/blob/21eef8df25d91e12635c36d8176ad192725baca2/LICENSE), and the bundled [PlayFair license](https://github.com/FDH2/UxPlay/blob/21eef8df25d91e12635c36d8176ad192725baca2/lib/playfair/LICENSE.md).
- [GStreamer 1.28.6 source](https://gitlab.freedesktop.org/gstreamer/gstreamer/-/tree/2d3e05cbdad68e47d645f548899b432dc9fb4473) and [license](https://gitlab.freedesktop.org/gstreamer/gstreamer/-/blob/2d3e05cbdad68e47d645f548899b432dc9fb4473/LICENSE).
- [gst-plugin-webrtc feature declaration](https://gitlab.freedesktop.org/gstreamer/gst-plugins-rs/-/blob/75e46c3a1b868e9a08fd688d091476b76a498df1/net/webrtc/Cargo.toml) and [producer/SFU behavior](https://gitlab.freedesktop.org/gstreamer/gst-plugins-rs/-/blob/75e46c3a1b868e9a08fd688d091476b76a498df1/net/webrtc/README.md).
- [LiveKit v1.13.6 source](https://github.com/livekit/livekit/tree/3cfbd1242618a61178f7a05b126d6c0c4cac3731) and [Apache-2.0 license](https://github.com/livekit/livekit/blob/3cfbd1242618a61178f7a05b126d6c0c4cac3731/LICENSE).
- [LiveKit browser client v2.21.0 source](https://github.com/livekit/client-sdk-js/tree/15ca5f8180ab8939c3a5a4dfee1d5e44f62f71cf), [Apache-2.0 license](https://github.com/livekit/client-sdk-js/blob/15ca5f8180ab8939c3a5a4dfee1d5e44f62f71cf/LICENSE), and [npm registry metadata](https://registry.npmjs.org/livekit-client/2.21.0).
- [Apple third-party trademark guidelines](https://www.apple.com/legal/intellectual-property/guidelinesfor3rdparties.html), [Apple MFi program description](https://mfi.apple.com/en/how-it-works), and [Apple FairPlay Streaming overview](https://developer.apple.com/streaming/fps/).
- The exact repositories, commits and pinned license-file digests for GLib, libplist, OpenSSL, Avahi, FFmpeg, libnice, libsrtp, usrsctp, libvpx, Opus and nv-codec-headers are in the machine-readable lock.

Git commit and annotated-tag object identifiers are exact candidates, but they are not substitutes for controlled SHA-256 release archives. The eventual build must mirror each source, record its SHA-256, verify any upstream signature against a separately trusted maintainer identity, and build with networking disabled. A tag containing an embedded PGP signature is recorded as `embedded-pgp-unverified`, not as verified. UxPlay `v1.73.6` is a lightweight unsigned tag.

## UxPlay provenance and FairPlay boundary

UxPlay describes itself as GPLv3 software derived through RPiPlay from ShairPlay and AirplayServer. It bundles PlayFair under GPL and llhttp under MIT. Its README also says the legal status of the third-party PlayFair library is unclear and places responsibility for local-law compliance on the user. That upstream warning is a release-blocking legal finding, not a notice that Team AI Box can resolve technically.

Counsel must review the exact UxPlay commit, the bundled PlayFair implementation, provenance of inherited files, anti-circumvention/interoperability law in every intended sales and deployment territory, and any contractual constraints. Engineering must not remove, rewrite or hide the upstream disclaimer to make the product appear approved.

The product boundary is narrower than the name of the bundled `playfair` directory may suggest:

- UxPlay says protected Apple video content cannot be decrypted by the receiver.
- Apple describes FairPlay Streaming as a protected HLS delivery system whose production credentials require approval.
- Team AI Box does not obtain, emulate, provide or claim FairPlay Streaming credentials.
- The feature must fail closed on protected content. It must not record, proxy, transcode, retry around, or provide instructions to bypass DRM.
- Required user-facing sentence: **“FairPlay/DRM-protected content is unsupported.”**
- Required Chinese sentence: **“不支持受 FairPlay/DRM 保护的内容。”**

The PlayFair legal review is still pending even though protected media is unsupported. The legacy receiver handshake code remains part of the shipped program and therefore cannot be ignored.

## Apple, MFi and trademark wording

No Apple authorization, MFi membership, AirPlay certification, badge license, logo license or Apple approval has been supplied. Apple’s published guidelines allow limited referential compatibility wording subject to conditions, but prohibit unauthorized logos and wording that creates endorsement or false association. Apple’s MFi page identifies AirPlay audio among licensed technologies and reserves MFi badges for certified accessories. Counsel must decide the final territorial wording and whether the intended receiver requires participation or other permission.

Until separately authorized, all UI, packaging, store copy, documentation and discovery help must use:

- **“AirPlay-compatible wireless casting (not Apple-certified)”**
- **“兼容 AirPlay 的无线投屏（非 Apple 认证）”**
- **“Team AI Box is an independent product and is not authorized, sponsored, endorsed, or approved by Apple Inc.”**
- **“Team AI Box 是独立产品，未经 Apple Inc. 授权、赞助、认可或批准。”**

“AirPlay” must be referential, less prominent than “Team AI Box”, and never part of the product or service name. Do not use the Apple logo, AirPlay icon/badge, MFi badge, Apple trade dress, or “Apple TV” imagery. Do not say “native AirPlay”, “official AirPlay”, “Apple receiver”, “Apple-certified”, “MFi-certified”, or anything implying endorsement. Include the final counsel-approved Apple trademark attribution in credits and notices.

## Codec and patent constraints

The first source candidate uses only the codecs needed for the stated workflows:

| Direction | Codec | Implementation candidate | Boundary |
| --- | --- | --- | --- |
| Client to receiver | H.264 | GStreamer `nvh264dec`, with FFmpeg `avdec_h264` only as an explicit fallback | Decode only; hardware/driver and patent clearance pending |
| Client to receiver | AAC | FFmpeg `avdec_aac` through `gst-libav` | Decode only; patent clearance pending |
| Client to receiver | ALAC | FFmpeg `avdec_alac` through `gst-libav` | Decode only; trademark/patent review pending |
| Receiver to browser | VP8 | GStreamer `vp8enc` with libvpx 1.17.0 | One publisher encode; performance and patent review pending |
| Receiver to browser | Opus | GStreamer `opusenc` with Opus 1.6.1 | One publisher encode; retain upstream patent notices |

VP8/Opus is selected to avoid adding H.264 browser encoding to the initial candidate. That is an engineering risk reduction, not a conclusion of non-infringement. The libvpx and Opus upstream patent-grant notices must be preserved. Patent counsel must clear H.264, AAC, ALAC, VP8 and Opus for manufacture, distribution and use in all target territories.

`nv-codec-headers` `n13.0.19.1` is only a header candidate. Its headers carry MIT-style notices, require a Linux NVIDIA driver at least 570.0, and do not grant a codec patent pool license. The host NVIDIA driver/runtime is not bundled by this source packet. Task 22.2 must prove the exact HDMI/GPU/driver path before build selection. If VP8 cannot meet 1080p30 within the appliance budget, the implementation must stop for a new codec and legal review; it must not silently enable x264, OpenH264 or NVENC H.264.

FFmpeg must be configured with `--disable-gpl`, `--disable-nonfree`, `--disable-everything`, and only the listed decoders/parsers. Any addition to FFmpeg, GStreamer or codec flags invalidates this review. In particular, FDK AAC and nonfree combinations are forbidden, and `gst-plugins-ugly` is not part of the candidate.

## Copyleft and distribution obligations to approve

The following is an engineering compliance plan for counsel to review, not a legal conclusion.

### UxPlay GPLv3 aggregate

The receiver image/program is treated conservatively as a GPLv3-covered combined work. If object code is conveyed on an appliance or as an image, the release process must:

1. Deliver all applicable GPL/LGPL/MIT/MPL/Apache/BSD texts, copyright notices, warranty disclaimers and this component inventory.
2. Provide Complete Corresponding Source for the exact UxPlay binary, including the exact upstream source, all Team AI Box patches, generated source needed to build, dependency/build scripts, compiler flags, container recipes and installation controls.
3. Mark modified files and identify the exact release/image digest to which the source corresponds.
4. Use a GPLv3 §6 source-delivery method and retention period approved by counsel; fill the source URL/offer fields in the NOTICE before release.
5. If the appliance is a GPLv3 “User Product” and Team AI Box retains installation capability, supply the required Installation Information so recipients can install modified covered software. Appliance security and signing controls may not make that right illusory.
6. Ensure product terms, EULA, secure-boot policy and anti-circumvention controls impose no further restriction on exercise of GPL rights.

UxPlay specifically recommends OpenSSL 3.0 or later to avoid the historical OpenSSL/GPL compatibility problem. The candidate uses OpenSSL 3.5.8 under Apache-2.0.

### LGPL, MPL and permissive components

- GStreamer, GLib, the selected libplist library, Avahi client/daemon compatibility pieces, FFmpeg in the locked configuration, and the selected libnice licensing branch are LGPL-2.1-or-later. Build them as replaceable shared libraries. Ship notices and exact source, and preserve a practical relink/replace path. Static linking is blocked unless counsel approves a compliant object/relink mechanism.
- `gst-plugin-webrtc` is MPL-2.0. Publish source and modifications for every MPL-covered file that is distributed and preserve MPL notices. Its Cargo feature closure must be generated from the exact lockfile rather than inferred from the manifest.
- LiveKit Server and its browser client are Apache-2.0. The server remains a separate internal SFU process, while the browser SDK may enter only the official plugin's controlled build and may not be loaded from a public CDN at runtime. Preserve their licenses, NOTICE obligations and patent clauses. Process separation does not remove the need to inventory the server image or the browser bundle and every bundled dependency.
- llhttp is MIT; libsrtp, usrsctp, libvpx and Opus use BSD-style terms; OpenSSL and LiveKit use Apache-2.0. Preserve all required notices, attribution and patent files.

The final legal bill of materials must map every installed file. The current top-level pin list is not a complete bill of materials: GStreamer/GLib transitive libraries, selected Rust crates, the LiveKit Go/image closure, base-image OS packages, NVIDIA user-space libraries and the final HDMI sink remain build-dependent.

## Security and supply-chain verification

All verification runs in digest-pinned ARM64 containers; no scanner is installed on the appliance host. Reuse the repository supply-chain policy, including exact identity matching, two independent ARM64 builds, SPDX JSON, SLSA provenance and immutable image digests.

1. **Source intake.** Fetch only the exact commits in the lock. Verify annotated tag signatures against independently obtained maintainer keys. For lightweight/unsigned tags, require an internal source-mirror attestation. Produce SHA-256 archives and reject any tree mismatch or network fetch during build.
2. **Feature closure.** Build GStreamer with an explicit plugin/element allowlist. Build gst-plugin-webrtc with default features disabled and only `livekit`. Build FFmpeg with the locked allowlist. Fail on a forbidden element, static LGPL library, unexpected dynamic object, unknown license or runtime downloader.
3. **SBOM.** Use the locked Syft 1.50.0 ARM64 image to produce SPDX JSON and CycloneDX for each final receiver and SFU image. Record image digest, scanner image digest, package relationships, files, license texts and source revisions. Reconcile the SBOM to `ldd`, GStreamer registry output, Rust Cargo.lock, Go build information and the OCI filesystem; an empty or partial upstream attestation is insufficient.
4. **Signatures and provenance.** Use the locked Cosign 3.0.6 ARM64 image. Verify source attestations where available, then verify the final internal image signature and SLSA provenance with exact issuer and identity. LiveKit’s observed BuildKit/SLSA attestation is useful parent evidence, but is not a verified signature and does not replace Team AI Box’s final-image attestation.
5. **Vulnerabilities.** Use the locked Grype 0.118.0 ARM64 image with a separately mirrored database whose digest and timestamp are recorded. Scan the digest-pinned final image and its SBOM. No Critical finding is allowed; every High finding needs an accountable, expiring exception with exploitability, compensating control and fixed-version plan. Evidence must be no older than 24 hours at release decision time.
6. **Reproducibility.** Build twice in independent builders with `SOURCE_DATE_EPOCH`, no mutable tags and no build network. The ARM64 OCI manifest digests must match. Sign only that result.
7. **Runtime policy proof.** Before promotion, prove non-root/read-only execution, minimal devices/capabilities, loopback-only SFU control, on-demand mDNS, ephemeral receiver identity/key/register, random one-time PIN, no persistent client trust, no recording, protected-content refusal, and exact teardown.

Observed registry metadata for LiveKit Server `v1.13.6` binds the ARM64 image to the selected source revision and exposes an attestation manifest, but no upstream SBOM attestation was observed and no trusted signature identity was verified. The LiveKit browser-client `v2.21.0` commit has a valid GitHub PGP verification and npm exposes signature/provenance metadata, but the annotated tag itself is unsigned. Engineering has not downloaded a controlled tarball, computed its SHA-256, verified the attestation subject against that byte sequence or reconciled the final browser bundle; those fields remain false and no SDK file is currently release-materialized.

## Session authentication cautions

UxPlay does not require PIN pairing by default. It also documents trust behavior for returning clients that can bypass the expected PIN if registration state is handled incorrectly. The product service must therefore use `-pin`, a session-local `-reg` file and a session-local `-key` on tmpfs, generate a new receiver identity for every session, and destroy the entire state directory at teardown. Password mode is prohibited because it can place a persistent secret on clients or in configuration.

The supervisor must construct the UxPlay argument vector from an exact allowlist rather than accepting a shell fragment, user option, startup file or inherited `UXPLAYRC`. Fixed options are `-rc /dev/null`, `-nh`, argument-less `-m`, `-s 1920x1080`, `-fps 30`, `-pin`, `-reg /run/teamaibox/uxplay.register` and `-key /run/teamaibox/uxplay.pem`. Only the session-random anonymous `-n` value and supervisor-owned fixed `-vs`/`-as` pipelines may vary. `-pw`, `-nohold`, `-hls`, `-mp4`, `-h265`, `-vdmp`, `-admp`, `-dacp`, `-ca`, `-md`, `-ble` and `-scrsv` are prohibited. This blocks password/downgrade behavior, client takeover, HLS/HEVC scope expansion, recording and raw dumps, metadata/cover-art writes, Bluetooth discovery and D-Bus screensaver integration. The rootfs must not contain a default user startup file, and the service must reject any unexpected option before process creation.

This is only a configuration candidate. Task 22.10 must prove with real iPhone/iPad/macOS clients that the negotiated protocol is authenticated and encrypted, does not downgrade, and refuses replay, wrong PIN, stale session state and protected content. If that proof fails, the receiver must not be advertised.

## Remaining gates and fail-closed rule

OpenSpec 22.1 must remain unchecked until every gate below is bound to the final build and approved:

- accountable counsel approves the exact UxPlay/PlayFair and inherited-code provenance for every target territory;
- accountable counsel approves Apple/MFi/trademark/product wording and the final attribution notice;
- patent counsel clears every ingress and egress codec, NVIDIA interface and distribution/use territory;
- distribution counsel approves the GPLv3 Corresponding Source, Installation Information, source-offer/retention and no-further-restrictions plan;
- controlled SHA-256 source mirrors, trusted signature identities, exact base images and the complete build closure are locked;
- final ARM64 receiver and SFU images have complete reconciled SBOMs, exact signatures, verified provenance, reproducible digests and fresh accepted vulnerability reports;
- task 22.2 selects and proves the actual HDMI, audio, GPU, driver and sink path;
- real-device authentication/encryption, FairPlay/DRM refusal, one-encode SFU fanout, cancellation and teardown tests pass.

Until then: no remote deployment, no release image, no AirPlay or MFi badge, no Apple-certified claim, and no `task22_1Complete=true` evidence. A later approval must be a new, reviewer-attested, digest-bound successor; do not mutate this pending packet into an approval.

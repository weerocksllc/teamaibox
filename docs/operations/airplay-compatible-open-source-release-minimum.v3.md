# AirPlay-Compatible Open-Source Release Minimum v3

Date: 2026-09-06

This record supersedes only the *required technical assurance scope* in the v2
review. It does not revoke or weaken the five approved human responsibility
decisions, the locked product wording, or the FairPlay/DRM exclusion.

## Authority decision

The requesting project authority stated: “我觉得不用这么麻烦，因为这个产品是开源的。”

For Team AI Box development builds and open-source distribution, the trusted
media component therefore reuses the normal project release controls. The
mandatory minimum is:

1. Pin each direct source revision and verify its SHA-256 before building.
2. Ship applicable license and NOTICE material.
3. Publish Team AI Box modifications, corresponding-source retrieval and build
   instructions with the open-source release.
4. Generate one basic SPDX JSON SBOM for the final ARM64 image.
5. Reject an image with any unaccepted Critical vulnerability.
6. Record the final OCI digest and verify the normal Team AI Box image
   signature.

A dedicated private source mirror, a separate AirPlay-specific SLSA statement,
a CycloneDX duplicate of the SPDX SBOM, and two byte-identical independent
builds are optional assurance. They are not development or open-source release gates.

The product wording remains **AirPlay-compatible wireless casting (not
Apple-certified)** / **兼容 AirPlay 的无线投屏（非 Apple 认证）**. Apple logos,
AirPlay/MFi certification badges and certification claims remain prohibited.
**FairPlay/DRM-protected content is unsupported.**

Locked English copy: AirPlay-compatible wireless casting (not Apple-certified)

Locked DRM boundary: FairPlay/DRM-protected content is unsupported.

This is an engineering scope record, not legal advice. It authorizes the
simplified build-and-verification work; it does not claim that those automated
artifacts already exist and does not by itself complete OpenSpec 22.1.

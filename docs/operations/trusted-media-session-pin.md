# Session PIN integration

This development successor uses the same pinned UxPlay 1.73.6 source archive
as the approved open-source v2 build. It additionally applies
`deploy/casting/uxplay-session-pin.patch` and includes the corresponding
GPL-compatible source in `services/trusted_media_service/native/session_pin.h`.
The original licenses, authors and NOTICE remain in the image.

The authorized Web session chooses a cryptographically random four-digit PIN
(1000–9999). It passes that same value only in the private TLS 1.3/mTLS start
body to the trusted-media service. The service must deliver it through the
receiver's anonymous stdin pipe, write exactly four digits and a newline, and
close the pipe. It must not place the PIN in command arguments, environment,
logs or a persistent file. The patched receiver rejects malformed input,
regular-file input, missing EOF, and input that exceeds a three-second total
deadline. It overrides any inherited/native random PIN and suppresses the
upstream PIN display callback. Failure happens before receiver advertisement.

The candidate also applies `uxplay-pairing-boundary.patch`: SRP public keys,
SHA-1 proofs, Ed25519 keys and GCM tags are length-checked before fixed-buffer
copies, and proof/confirmation calls without the required prior state fail
closed. `uxplay-ephemeral-identity.patch` generates a fresh receiver identity
for each process instead of deriving a persistent identity from the public
device ID. These changes are compiled and exercised against the actual ARM64
AirPlay library, including malformed and out-of-order requests. The image
tests additionally check anonymous-pipe input and absence of the PIN from
receiver output; they run with networking disabled and do not prove Apple
device interoperability or successful mDNS advertisement.

Build the development candidate on ARM64 Docker:

```sh
docker build --platform linux/arm64/v8 \
  -f deploy/casting/TrustedMediaService.arm64.session-pin.Dockerfile \
  -t teamaibox/trusted-media-service:session-pin-candidate .
```

This is not a claim of deployed or accepted casting. It does not yet supply
the native source-authentication callback adapter, receiver-side brute-force
controls, HDMI negotiation or the browser publisher/SFU implementation.
Do not advertise it to users before those boundaries are integrated and tested.
The normal release-minimum signature, SPDX and vulnerability checks must bind
the final runtime image, not merely its unmodified v2 parent. No new legal
approval or duplicate byte-identical build is required by this implementation.

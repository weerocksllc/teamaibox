# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# Assembles only the independently compiled, hash-verified ARM64 plugin.
# The bounded build tool verifies this exact local Python/GDP parent image:
# sha256:42d8101a714bf269965e859d34676f40feaa1afdde8a4385708474687e6df685
FROM ${BUILD_PARENT_1}
USER 0:0
COPY libgstrswebrtc.so /usr/lib/aarch64-linux-gnu/gstreamer-1.0/libgstrswebrtc.so
COPY LICENSE-MPL-2.0 /usr/share/doc/teamaibox-trusted-media/gst-plugins-rs-LICENSE-MPL-2.0
RUN echo 'ade3568c041229c41e0a4c421d50ae0e4a13895ed06afb20bf0cdc97cf4c9a30  /usr/lib/aarch64-linux-gnu/gstreamer-1.0/libgstrswebrtc.so' | sha256sum --check --strict
USER 65532:65532
RUN GST_REGISTRY=/tmp/gstreamer-component-registry.bin gst-inspect-1.0 livekitwebrtcsink >/dev/null
LABEL org.teamaibox.gst-plugins-rs.revision="75e46c3a1b868e9a08fd688d091476b76a498df1" \
      org.teamaibox.gst-plugins-rs.lock-sha256="ceea5a17b4497a14bbcc2bc3bc32015bda5307c6b33f7634c6d5679cdf0559ca" \
      org.teamaibox.claim="development-component-not-product-accepted"

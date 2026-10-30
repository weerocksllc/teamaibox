# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
ARG BUILD_PARENT_2
# Invoker verifies both exact cached input identities before and after build.
FROM ${BUILD_PARENT_1} AS sources
FROM ${BUILD_PARENT_2}
USER 0:0
COPY deploy/legal/airplay-compatible/NOTICE.v3.txt /usr/share/doc/teamaibox-trusted-media/NOTICE
COPY deploy/casting/uxplay-*.patch /usr/share/teamaibox/source/patches/
COPY services/trusted_media_service/native /usr/share/teamaibox/source/native/
COPY deploy/casting/TrustedMediaService.arm64.session-pin.Dockerfile deploy/casting/TrustedMediaWebrtcPlugin.arm64.Dockerfile /usr/share/teamaibox/source/build/
COPY docs/operations/trusted-media-browser-build-20260908.md /usr/share/teamaibox/source/BUILD.md
COPY --from=sources /build/gst-rs/src/Cargo.lock /usr/share/teamaibox/source/gst-plugins-rs/Cargo.lock
RUN echo 'ceea5a17b4497a14bbcc2bc3bc32015bda5307c6b33f7634c6d5679cdf0559ca  /usr/share/teamaibox/source/gst-plugins-rs/Cargo.lock' | sha256sum --check --strict \
 && chmod -R a=rX /usr/share/teamaibox/source /usr/share/doc/teamaibox-trusted-media
USER 65532:65532
LABEL org.teamaibox.claim="development-browser-service-not-product-accepted" \
      org.teamaibox.receiver.source-modified="true"

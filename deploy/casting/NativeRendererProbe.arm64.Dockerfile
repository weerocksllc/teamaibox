# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
ARG BUILD_PARENT_2
FROM ${BUILD_PARENT_1} AS build
COPY tools/casting_native_renderer_probe.c /probe.c
RUN cc -I/build/src /probe.c /build/out/renderers/librenderers.a /build/out/lib/libairplay.a $(pkg-config --cflags --libs gstreamer-1.0 gstreamer-video-1.0 gstreamer-app-1.0 libplist-2.0 libavcodec libavutil) -lcrypto -lm -o /renderer-probe
FROM ${BUILD_PARENT_2}
COPY --from=build --chmod=0555 /renderer-probe /usr/local/bin/renderer-probe
ENTRYPOINT ["/usr/local/bin/renderer-probe"]

# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
FROM ${BUILD_PARENT_1} AS build
COPY deploy/casting/uxplay-*.patch /lifecycle/patches/
COPY services/trusted_media_service/native/ /lifecycle/native/
WORKDIR /lifecycle
RUN echo '03a92523cf750af87be594974819cd6709c5e7a6f8863f109b418b246acf9c5c  /build/uxplay.tar.gz' | sha256sum --check --strict \
 && mkdir src \
 && tar xzf /build/uxplay.tar.gz --strip-components=1 -C src \
 && for name in session-pin pairing-boundary ephemeral-identity pairing-budget paired-peer platform-pairing-ack setup-secret video-geometry source-lifecycle; do patch --batch --fuzz=0 -d src -p1 < patches/uxplay-$name.patch || exit 1; done \
 && cp native/session_pin.h src/teamaibox_session_pin.h \
 && for name in pairing_budget paired_peer platform_pairing_ack setup_secret; do cp native/$name.h src/lib/teamaibox_$name.h; done \
 && cmake -S src -B out -DCMAKE_BUILD_TYPE=Release -DCMAKE_CXX_FLAGS=-DTEAMAIBOX_PIN_STDIN -DCMAKE_C_FLAGS=-DTEAMAIBOX_PIN_STDIN -DNO_MARCH_NATIVE=ON -DNO_X11_DEPS=ON -DCMAKE_INSTALL_PREFIX=/usr \
 && cmake --build out --parallel 2 \
 && cc -Wall -Wextra -Werror native/platform_pairing_ack_test.c -o ack-test && ./ack-test \
 && cc -DTEAMAIBOX_PIN_STDIN -I src/lib native/pairing_boundary_test.c out/lib/libairplay.a -lcrypto -lpthread -o boundary-test && ./boundary-test
FROM scratch
COPY --from=build /lifecycle/out/uxplay /uxplay

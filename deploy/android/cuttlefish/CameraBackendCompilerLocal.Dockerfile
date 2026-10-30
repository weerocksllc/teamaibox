# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# Build-only successor using public compiler libraries already installed on
# the Spark. No host package install, guest change or production mount.
FROM ${BUILD_PARENT_1}
COPY lib/ /opt/phone-clang/lib/
COPY include/ /opt/phone-clang/clang/18/include/
ENV LIBCLANG_PATH=/opt/phone-clang/lib
ENV LD_LIBRARY_PATH=/opt/phone-clang/lib
ENV BINDGEN_EXTRA_CLANG_ARGS="-I/usr/include/aarch64-linux-gnu -resource-dir=/opt/phone-clang/clang/18"
RUN test -f /opt/phone-clang/lib/libclang-18.so.18 && \
    ldd /opt/phone-clang/lib/libclang-18.so.18 && \
    ! ldd /opt/phone-clang/lib/libclang-18.so.18 | grep 'not found'

# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
FROM ${BUILD_PARENT_1}
COPY clang /opt/phone-clang/bin/clang
COPY libclang-cpp.so.18.1 /opt/phone-clang/lib/libclang-cpp.so.18.1
ENV PATH="/opt/phone-clang/bin:${PATH}"
RUN /opt/phone-clang/bin/clang --version
WORKDIR /work

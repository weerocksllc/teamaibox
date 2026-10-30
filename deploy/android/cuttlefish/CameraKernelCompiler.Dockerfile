# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
FROM ${BUILD_PARENT_1}
USER root
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::https::Timeout=20 -o Acquire::Retries=2 update \
    && apt-get -o Acquire::https::Timeout=20 -o Acquire::Retries=2 install -y --no-install-recommends \
    clang-19 llvm-19 lld-19 libelf-dev bc flex bison kmod \
    && rm -rf /var/lib/apt/lists/*
ENV PATH="/usr/lib/llvm-19/bin:${PATH}"
WORKDIR /work

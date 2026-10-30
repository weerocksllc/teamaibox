# Layered recipe: pass parents built from public sources. For the complete
# supported path, see install/PUBLIC-BUILD.md; no developer image is implicit.
ARG BUILD_PARENT_1
# Isolated build tools only; never installed on the Mac or Spark hosts.
FROM ${BUILD_PARENT_1}
RUN apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update && \
    apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 install -y --no-install-recommends libclang1-14 libclang-common-14-dev && \
    rm -rf /var/lib/apt/lists/*
ENV LIBCLANG_PATH=/usr/lib/llvm-14/lib

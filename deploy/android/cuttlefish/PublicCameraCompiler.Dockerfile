FROM docker.io/library/rust@sha256:271849e998ffce5776454bbf98c5dc21baafc854ff8e566197908d3aca9a81e8
RUN apt-get -o Acquire::Retries=2 update \
 && apt-get install -y --no-install-recommends libclang-dev clang llvm lld libelf-dev bc flex bison kmod \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /work

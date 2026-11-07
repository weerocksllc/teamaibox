# syntax=docker/dockerfile:1
# Candidate only: never relabel this binary with the upstream archive digest.
FROM docker.io/library/node@sha256:682f301a9e8e5731d4bb1889182a2186fe65a312cc81ae86cea6038ef8b1603f AS source-build
ADD --checksum=sha256:baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e \
    https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-aarch64.zip /tmp/bun.zip
RUN apt-get update && apt-get install -y --no-install-recommends unzip \
    && unzip -p /tmp/bun.zip bun-linux-aarch64/bun > /usr/local/bin/bun \
    && chmod 0755 /usr/local/bin/bun && test "$(bun --version)" = '1.4.4' \
    && rm -rf /var/lib/apt/lists/* /tmp/bun.zip
WORKDIR /source
COPY . .
ENV HUSKY=0 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN --mount=type=cache,id=teamaibox-opencode-bun-arm64,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts --filter opencode --filter @opencode-ai/script --filter @opencode-ai/plugin
# The native SDK resolver uses this version. Patch identity belongs to the
# separately hashed manifest, not an unpublished SDK package version.
ENV OPENCODE_VERSION=1.19.5 OPENCODE_CHANNEL=teamaibox OPENCODE_RELEASE=""
ENV MODELS_DEV_API_JSON=/source/teamaibox-models.json
WORKDIR /source/packages/opencode
RUN bun run script/build.ts --single --skip-install --skip-embed-web-ui
RUN sha256sum dist/opencode-linux-arm64/bin/opencode > /source/teamaibox-binary.sha256

FROM scratch AS artifact
COPY --from=source-build /source/packages/opencode/dist/opencode-linux-arm64/bin/opencode /opencode
COPY --from=source-build /source/teamaibox-transport-patch.json /teamaibox-transport-patch.json
COPY --from=source-build /source/teamaibox-binary.sha256 /teamaibox-binary.sha256
COPY --from=source-build /source/LICENSE /LICENSE.opencode

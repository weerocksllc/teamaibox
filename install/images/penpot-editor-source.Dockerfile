# Isolated source-build pilot; not an appliance runtime image.
# Context: complete, checksum-verified Penpot source from prepare_penpot_source.py.
FROM docker.io/library/node:24.22.1-bookworm-slim@sha256:932a44adcdb8f5dfbf00f00eb38da8d22b450b2ad258b6d1b2319beca823bfbd AS toolchain
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git unzip rsync python3 build-essential pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*
# JDK is the exact ARM64 toolchain selected by the pinned upstream devenv.
RUN curl -fL --retry 3 https://cdn.azul.com/zulu/bin/zulu27.28.101-ca-jdk27.0.0-linux_aarch64.tar.gz -o /tmp/jdk.tar.gz \
    && echo '9fa5bf865783c43840101fcdc3a5222b60daf4fe11f26806247bf807c08aba38  /tmp/jdk.tar.gz' | sha256sum -c - \
    && mkdir -p /opt/jdk && tar -xf /tmp/jdk.tar.gz --strip-components=1 -C /opt/jdk \
    && rm /tmp/jdk.tar.gz
RUN curl -fL --retry 3 https://download.clojure.org/install/clojure-tools-1.12.5.1664.tar.gz -o /tmp/clojure.tar.gz \
    && echo '77dd6868948074adcc93e83a796f8e8f15a1a92bcb1b9002d715fd2210e476f3  /tmp/clojure.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/clojure.tar.gz -C /tmp \
    && mkdir -p /opt/clojure/libexec /opt/clojure/bin \
    && cp /tmp/clojure-tools/deps.edn /tmp/clojure-tools/example-deps.edn /tmp/clojure-tools/tools.edn /opt/clojure/ \
    && cp /tmp/clojure-tools/*.jar /opt/clojure/libexec/ \
    && sed 's@PREFIX@/opt/clojure@g' /tmp/clojure-tools/clojure > /opt/clojure/bin/clojure \
    && chmod +x /opt/clojure/bin/clojure \
    && rm -r /tmp/clojure-tools /tmp/clojure.tar.gz
RUN curl -fL --retry 3 https://github.com/pnpm/pnpm/releases/download/v12.15.0/pnpm-linux-arm64.tar.gz -o /tmp/pnpm.tar.gz \
    && echo 'd7ce93a2c7d847d3a34bd3f559b60c14f578b1320c17cc352a2c5c5fdf956117  /tmp/pnpm.tar.gz' | sha256sum -c - \
    && tar -xzf /tmp/pnpm.tar.gz -C /usr/local/bin pnpm && rm /tmp/pnpm.tar.gz
ENV JAVA_HOME=/opt/jdk PATH=/opt/jdk/bin:/opt/clojure/bin:$PATH \
    npm_config_manage_package_manager_versions=false npm_config_package_manager_strict=false

FROM toolchain AS backend-build
WORKDIR /opt/penpot
COPY common common
COPY backend backend
COPY CHANGES.md LICENSE ./
WORKDIR /opt/penpot/common
RUN --mount=type=cache,id=teamaibox-penpot-maven-arm64,target=/root/.m2,sharing=locked \
    --mount=type=cache,id=teamaibox-penpot-clojure-arm64,target=/root/.gitlibs,sharing=locked \
    clojure -T:build compile
WORKDIR /opt/penpot/backend
RUN --mount=type=cache,id=teamaibox-penpot-maven-arm64,target=/root/.m2,sharing=locked \
    --mount=type=cache,id=teamaibox-penpot-clojure-arm64,target=/root/.gitlibs,sharing=locked \
    mkdir -p target/classes && printf '2.18.5\n' > target/classes/version.txt \
    && cp ../CHANGES.md target/classes/changelog.md && clojure -T:build jar
# This target proves compilation only. Runtime media dependencies, templates,
# native login, editor and exports must pass before a release role is produced.

FROM toolchain AS wasm-toolchain
ENV CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup PATH=/opt/cargo/bin:$PATH
RUN curl -fL --retry 3 https://static.rust-lang.org/rustup/archive/1.28.2/aarch64-unknown-linux-gnu/rustup-init -o /tmp/rustup-init \
    && echo 'e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c  /tmp/rustup-init' | sha256sum -c - \
    && chmod +x /tmp/rustup-init \
    && /tmp/rustup-init -y --no-modify-path --profile minimal --default-toolchain 1.91.0 --default-host aarch64-unknown-linux-gnu \
    && rustup target add wasm32-unknown-emscripten && rm /tmp/rustup-init
RUN curl -fL --retry 3 https://codeload.github.com/emscripten-core/emsdk/tar.gz/24fc909c0da13ef641d5ae75e89b5a97f25e37aa -o /tmp/emsdk.tar.gz \
    && echo '51233b04299acee486b1237be6e58663a5c9fcb07f106df076e3d368919005a7  /tmp/emsdk.tar.gz' | sha256sum -c - \
    && mkdir -p /opt/emsdk && tar -xzf /tmp/emsdk.tar.gz --strip-components=1 -C /opt/emsdk \
    && cd /opt/emsdk && ./emsdk install 4.0.6 && ./emsdk activate 4.0.6 && rm /tmp/emsdk.tar.gz
RUN curl -fL --retry 3 https://github.com/penpot/skia-binaries/releases/download/0.93.1/skia-binaries-319323662b1685a112f5-wasm32-unknown-emscripten-gl-svg-textlayout-binary-cache-webp.tar.gz -o /opt/skia-wasm.tar.gz \
    && echo '930a88fc283673426bcc328e027b1e971f898123e3867ff2ef04b8d03a434f1d  /opt/skia-wasm.tar.gz' | sha256sum -c -
ENV SKIA_BINARIES_URL=file:///opt/skia-wasm.tar.gz

FROM wasm-toolchain AS frontend-build
WORKDIR /opt/penpot
COPY . .
ENV CI=true
WORKDIR /opt/penpot/common
RUN --mount=type=cache,id=teamaibox-penpot-maven-arm64,target=/root/.m2,sharing=locked \
    --mount=type=cache,id=teamaibox-penpot-clojure-arm64,target=/root/.gitlibs,sharing=locked \
    clojure -T:build compile
WORKDIR /opt/penpot/frontend
# On ARM64, canvas may need to compile from source. pnpm does not add
# npm's bundled node-gyp to PATH. Use the pinned Node image's tool and
# matching headers rather than downloading another toolchain.
RUN test -r /usr/local/include/node/node.h \
    && ln -s /usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js /usr/local/bin/node-gyp \
    && node-gyp --version
ENV npm_config_nodedir=/usr/local
# Bound only compiler processes; do not change runtime resource policy or reserve
# capacity for this app. Bound native Angular workers too: upstream's parallel
# workspace build otherwise starts many independent Node heaps at once.
ENV JAVA_TOOL_OPTIONS="-Xmx3g -XX:ActiveProcessorCount=2" \
    NODE_OPTIONS="--max-old-space-size=1536" CARGO_BUILD_JOBS=2 NG_BUILD_MAX_WORKERS=2
RUN node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const path = '../plugins/package.json';
const value = JSON.parse(readFileSync(path, 'utf8'));
const before = "pnpm --parallel --filter './apps/*-plugin' --filter './apps/*-test-suite' --filter '!poc-state-plugin' build";
if (value.scripts['build:plugins'] !== before) throw new Error('Native plugin build contract changed');
value.scripts['build:plugins'] = before.replace('--parallel', '--workspace-concurrency=1');
writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
JS
RUN --mount=type=cache,id=teamaibox-penpot-maven-arm64,target=/root/.m2,sharing=locked \
    --mount=type=cache,id=teamaibox-penpot-clojure-arm64,target=/root/.gitlibs,sharing=locked \
    --mount=type=cache,id=teamaibox-penpot-pnpm-arm64,target=/opt/penpot/.pnpm-store,sharing=locked \
    --mount=type=cache,id=teamaibox-penpot-cargo-arm64,target=/opt/cargo/registry,sharing=locked \
    --mount=type=cache,id=teamaibox-penpot-font-preview,target=/tmp/penpot-fonts-preview-cache,sharing=locked \
    bash scripts/build 2.18.5

# This upstream source revision's runtime consumes CSP hashes, but its asset
# build omits the file. Derive hashes from the exact emitted inline scripts.
RUN node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const hashes = new Set();
for (const name of ['index.html', 'rasterizer.html', 'render.html']) {
  const html = readFileSync('target/dist/' + name, 'utf8');
  let found = 0;
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(attrs) || !body.trim()) continue;
    hashes.add(`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
    found++;
  }
  if (!found) throw new Error('Expected inline scripts in compiled Penpot page: ' + name);
}
writeFileSync('target/dist/csp-script-hashes.txt', [...hashes].join(' ') + '\n');
JS

# Native media dependency, built from public source rather than pulling the
# upstream prebuilt penpotapp/imagemagick role.
FROM toolchain AS imagemagick-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    autoconf libfftw3-dev libheif-dev liblcms2-dev libltdl-dev liblzma-dev \
    libxml2-dev libpng-dev libtiff-dev libtool libwebp-dev libzip-dev libzstd-dev \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fL --retry 3 https://codeload.github.com/ImageMagick/ImageMagick/tar.gz/refs/tags/7.1.2-32 -o /tmp/magick.tar.gz \
    && echo '940e349f0ef394e658fd57400b83d1d7a81b954f6e7bdbfbfad31b2718c10add  /tmp/magick.tar.gz' | sha256sum -c - \
    && mkdir /tmp/magick && tar -xzf /tmp/magick.tar.gz --strip-components=1 -C /tmp/magick \
    && cd /tmp/magick && ./configure --prefix=/opt/imagick --without-openexr \
    && make -j2 && make install && rm -r /tmp/magick /tmp/magick.tar.gz

FROM docker.io/library/node:24.22.1-bookworm-slim@sha256:932a44adcdb8f5dfbf00f00eb38da8d22b450b2ad258b6d1b2319beca823bfbd AS media-runtime
ENV LANG=C.UTF-8 PATH=/opt/imagick/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates fontconfig fontforge fonts-dejavu-core fonts-noto-core \
    fonts-noto-cjk fonts-noto-color-emoji libfftw3-double3 libheif1 \
    libjpeg62-turbo liblcms2-2 libltdl7 libopenjp2-7 libpng16-16 librsvg2-2 \
    libtiff6 libwebp7 libwebpdemux2 libwebpmux3 libxml2 libzip4 libzstd1 \
    woff-tools woff2 python3 python3-tabulate \
    && rm -rf /var/lib/apt/lists/*
COPY --from=imagemagick-build /opt/imagick /opt/imagick
COPY docker/images/files/imagemagick-policy.xml /opt/imagick/etc/ImageMagick-7/policy.xml
RUN ldconfig /opt/imagick/lib && magick -version
RUN groupadd -g 1001 penpot && useradd -M -u 1001 -g penpot -s /usr/sbin/nologin penpot

# Pilot runtime: same JDK as the source compiler. No appliance registration,
# built-in templates or identity handoff is implied by this target.
FROM media-runtime AS backend-runtime
ENV JAVA_HOME=/opt/jdk PATH=/opt/jdk/bin:$PATH
COPY --from=toolchain /opt/jdk /opt/jdk
WORKDIR /opt/penpot/backend
COPY --from=backend-build /opt/penpot/backend/target/penpot.jar ./
COPY backend/resources/log4j2.xml backend/scripts/run.template.sh ./
COPY LICENSE /opt/penpot/LICENSE
RUN mkdir -p /opt/data/assets && chown -R penpot:penpot /opt/data /opt/penpot
USER penpot
CMD ["bash", "run.template.sh"]

FROM toolchain AS exporter-build
WORKDIR /opt/penpot
COPY common common
COPY exporter exporter
COPY LICENSE ./
ENV CI=true
WORKDIR /opt/penpot/common
RUN --mount=type=cache,id=teamaibox-penpot-maven-arm64,target=/root/.m2,sharing=locked \
    --mount=type=cache,id=teamaibox-penpot-clojure-arm64,target=/root/.gitlibs,sharing=locked \
    clojure -T:build compile
WORKDIR /opt/penpot/exporter
RUN --mount=type=cache,id=teamaibox-penpot-maven-arm64,target=/root/.m2,sharing=locked \
    --mount=type=cache,id=teamaibox-penpot-clojure-arm64,target=/root/.gitlibs,sharing=locked \
    bash scripts/build 2.18.5

FROM media-runtime AS exporter-runtime
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/penpot/browsers CI=true \
    npm_config_manage_package_manager_versions=false npm_config_package_manager_strict=false
COPY --from=toolchain /usr/local/bin/pnpm /usr/local/bin/pnpm
COPY --from=exporter-build /opt/penpot/exporter/target /opt/penpot/exporter
COPY LICENSE /opt/penpot/LICENSE
WORKDIR /opt/penpot/exporter
RUN pnpm install --frozen-lockfile && pnpm exec playwright install --with-deps chromium \
    && node -e 'require("node:fs").accessSync(require("playwright").chromium.executablePath(), require("node:fs").constants.X_OK)' \
    && for language in en zh ar; do test -n "$(fc-list ":lang=$language" family)" || exit 1; done \
    && chown -R penpot:penpot /opt/penpot && rm -rf /var/lib/apt/lists/*
USER penpot
CMD ["node", "app.js"]

FROM docker.io/library/nginx:1.31.7@sha256:ec4d2c7b6b59eb4681283aa2f3d675a2c539f8c3630f84959b5c5844d3481080 AS frontend-runtime
RUN groupadd -g 1001 penpot && useradd -M -u 1001 -g penpot -s /usr/sbin/nologin penpot \
    && mkdir -p /opt/data/assets /etc/nginx/overrides/main.d /etc/nginx/overrides/http.d \
    /etc/nginx/overrides/server.d /etc/nginx/overrides/assets.d /etc/nginx/overrides/location.d
COPY --from=frontend-build /opt/penpot/frontend/target/dist /var/www/app/
RUN test -s /var/www/app/js/render-wasm.wasm \
    && test -s /var/www/app/fonts/WorkSans-VariableFont.ttf \
    && test -s /var/www/app/fonts/Vazirmatn-Regular.woff2
COPY LICENSE /opt/penpot/LICENSE
COPY docker/images/files/config.js /var/www/app/js/config.js
COPY docker/images/files/nginx.conf.template /tmp/nginx.conf.template
# The custom entrypoint bypasses the base image's worker autotuning.
# Keep a bounded count so nginx does not fork a worker per host CPU.
RUN test "$(head -n 1 /tmp/nginx.conf.template)" = 'worker_processes auto;' \
    && sed -i '1s/^worker_processes auto;$/worker_processes 2;/' /tmp/nginx.conf.template
COPY docker/images/files/nginx-resolvers.conf.template /tmp/resolvers.conf.template
COPY docker/images/files/nginx-admin-console-locations.conf.template /tmp/nginx-admin-console-locations.conf.template
COPY docker/images/files/nginx-mcp-locations.conf.template /tmp/nginx-mcp-locations.conf.template
COPY docker/images/files/nginx-security-headers.conf.template /tmp/nginx-security-headers.conf.template
COPY docker/images/files/nginx-mime.types /etc/nginx/mime.types
COPY docker/images/files/nginx-external-locations.conf /etc/nginx/overrides/location.d/external-locations.conf
# A shipped appliance must start without DNS or public internet. Keep native
# bundled/custom fonts; external template/font fetches are not offline assets.
# Explicitly reject these optional routes, rather than proxying user traffic or
# resolving external hosts during nginx startup.
RUN printf '%s\n' 'location /github/ { return 404; }' \
    'location /internal/gfonts/ { return 404; }' \
    > /etc/nginx/overrides/location.d/external-locations.conf
COPY docker/images/files/nginx-entrypoint.sh /entrypoint.sh
# Resolve native service names at request time. Static proxy_pass authorities
# would prevent nginx starting if the optional exporter was not yet present,
# and retain obsolete backend addresses after a container replacement. Keep
# the original request path/query; the operator supplies only fixed origins.
RUN test "$(grep -Fc 'proxy_pass $PENPOT_' /tmp/nginx.conf.template)" = 6 \
    && sed -i 's|proxy_pass \$PENPOT_BACKEND_URI[^;]*;|set $tab_backend "$PENPOT_BACKEND_URI"; proxy_pass $tab_backend$request_uri;|g; s|proxy_pass \$PENPOT_EXPORTER_URI;|set $tab_exporter "$PENPOT_EXPORTER_URI"; proxy_pass $tab_exporter$request_uri;|g' /tmp/nginx.conf.template
# Native SES initializes on editor startup and requires eval inside its
# compartment. Keep the upstream hash-based CSP enforced for this dedicated
# image, including same-origin resource and frame restrictions. Do not weaken
# the platform shell or generic plugin policy to accommodate the editor.
ENV PENPOT_CSP_MODE=enforce PENPOT_CSP_SCRIPT_SRC_EXTRA="'unsafe-eval'"
RUN test -s /var/www/app/csp-script-hashes.txt \
    && mv /var/www/app/csp-script-hashes.txt /etc/nginx/csp-script-hashes.txt \
    && chown -R penpot:penpot /var/cache/nginx /etc/nginx /var/www /opt/data
USER penpot
ENTRYPOINT ["/bin/bash", "/entrypoint.sh"]
CMD ["nginx", "-g", "daemon off;"]

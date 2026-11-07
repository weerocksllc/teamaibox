# BASE is a verified local alias of the source-built product Agent image ID.
# It is not a Penpot application image or a maintainer registry dependency.
ARG AGENT_BASE
FROM ${AGENT_BASE}
# Runtime upgrade provenance is recorded by build_penpot_agent.py.
# The source build has a separate release channel for attribution, but must
# open the same native SQLite database as the pinned upstream 1.19.5 binary.
# Never create a second session store just because Penpot is enabled.
ENV OPENCODE_DISABLE_CHANNEL_DB=1
USER 0:0
ARG BINARY_SHA256
COPY artifact/opencode /opt/opencode/opencode
COPY artifact/teamaibox-transport-patch.json /opt/opencode/teamaibox-transport-patch.json
COPY artifact/LICENSE.opencode /opt/opencode/LICENSE.transport
COPY --chown=65532:65532 runtime/ /opt/teamaibox/
RUN printf '%s  %s\n' "${BINARY_SHA256}" /opt/opencode/opencode | sha256sum --check --strict \
    && chmod 0555 /opt/opencode/opencode \
    && chmod -R a+rX /opt/opencode/native-extensions \
    && test "$(/opt/opencode/opencode --version)" = '1.19.5'
USER 65532:65532
RUN node --check /opt/teamaibox/validation/opencode-agent-sandbox-main.mjs \
    && node --check /opt/teamaibox/validation/opencode-bridge-main.mjs \
    && node --input-type=module -e "await import('/opt/teamaibox/services/agent-bridge/src/opencode-bridge-http-server.mjs'); await import('/opt/teamaibox/services/agent-bridge/src/penpot-native-activation.mjs'); await import('/opt/teamaibox/services/agent-bridge/src/penpot-credential-transport.mjs'); const { seedNativeExtensionRuntime } = await import('/opt/teamaibox/services/agent-bridge/src/native-extension-seed.mjs'); const fs = await import('node:fs/promises'); const scratch = await fs.mkdtemp('/tmp/opencode-seed-'); try { if (!(await seedNativeExtensionRuntime('/opt/opencode/native-extensions', scratch))) process.exitCode = 1; } finally { await fs.rm(scratch, {recursive:true,force:true}); }"

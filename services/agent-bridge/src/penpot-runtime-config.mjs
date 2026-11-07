// Managed defaults only. Native user/project configuration remains owned by
// OpenCode; never read, replace or reformat the user's config or Skills here.
export const penpotRuntimePaths = Object.freeze({
  context: '/run/teamaibox/penpot/context.json',
  bridgeToken: '/run/teamaibox/secrets/agent-bridge-token',
  plugin: 'file:///opt/teamaibox/services/agent-bridge/src/penpot-native-dispatch-plugin.mjs',
  endpoint: 'http://127.0.0.1:4098/mcp',
  entry: 'teamaibox-penpot',
});
export function privateDesignOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new TypeError('Invalid design service origin');
  return url.origin;
}
// Optional Design configuration must not prevent the owner's ordinary Agent
// from starting. Keep rejection observable without logging operator URLs.
export function safePenpotConfiguration(configuration, onInvalid = () => {}) {
  if (configuration == null) return undefined;
  try {
    penpotRuntimeContext('00000000-0000-4000-8000-000000000001', configuration);
    return structuredClone(configuration);
  } catch {
    onInvalid('penpot_runtime_configuration_invalid');
    return {enabled: false};
  }
}
export function penpotRuntimeContext(identityId, configuration) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(identityId ?? '')) {
    throw new TypeError('Invalid design runtime owner');
  }
  if (configuration == null || configuration.enabled === false) return {schemaVersion: 1, enabled: false};
  if (configuration.enabled !== true || configuration.transportRevision !== 'teamaibox-penpot-transport-2') {
    throw new TypeError('Design requires the patched native runtime');
  }
  return {schemaVersion: 1, enabled: true, identityId,
    bridgeTokenFile: penpotRuntimePaths.bridgeToken,
    proofEndpoint: privateDesignOrigin(configuration.platformOrigin) + '/internal/v1/design/call-proof',
    mcpEndpoint: privateDesignOrigin(configuration.mcpOrigin) + '/mcp',
    transportRevision: configuration.transportRevision};
}
export function withPenpotRuntimeConfig(config, context) {
  const result = structuredClone(config);
  if (!context) return result;
  // Preload the harmless dispatch hook even while Design is disabled so a
  // later enable can use native MCP.add without disposing active instances.
  result.plugin = [...new Set([...(result.plugin ?? []), penpotRuntimePaths.plugin])];
  if (!context.enabled) return result;
  if (result.mcp?.[penpotRuntimePaths.entry] !== undefined) throw new TypeError('Reserved design entry collision');
  result.mcp = {...result.mcp, [penpotRuntimePaths.entry]: {
    type: 'remote', url: penpotRuntimePaths.endpoint, enabled: true, oauth: false,
  }};
  return result;
}

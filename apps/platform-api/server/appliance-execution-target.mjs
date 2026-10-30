const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Older installed plugin/training files contain an explicit executor. They
// remain readable, but cannot select a second device or another service port.
export function requireLocalApplianceExecutionTarget(environment, target) {
  const nodeId = environment.PLATFORM_APPLIANCE_NODE_ID;
  const port = Number(environment.PLATFORM_APPLIANCE_AGENT_PORT || 9443);
  if (!UUID.test(nodeId ?? '') || target?.nodeId !== nodeId
      || !['127.0.0.1', '::1', 'localhost'].includes(target?.host)
      || !Number.isSafeInteger(port) || port < 1 || port > 65535
      || Number(target?.port) !== port) {
    throw new TypeError('Execution configuration must use this appliance and its loopback Agent');
  }
}

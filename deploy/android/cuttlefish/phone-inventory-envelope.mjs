import {DEFAULT_MANAGED_NODE_CONTROL_PLANE_RESERVE,projectManagedNodeLeaseCapacity} from '../../../services/scheduler/src/managed-node-scheduling.mjs';
import {phoneRuntimeResources} from '../../../services/scheduler/src/virtual-phone-capacity.mjs';

// Heartbeat inventory is the pre-reserve envelope. Two phones use 4 CPU / 12
// GiB; the common control-plane reserve is deducted by the existing scheduler.
export function phoneInventoryEnvelope(previous) {
  const result=structuredClone(previous), reserve=DEFAULT_MANAGED_NODE_CONTROL_PLANE_RESERVE;
  if(result.runtimes?.length!==1 || result.runtimes[0].runtimeKey!=='cuttlefish-aosp')throw Error('not_phone_inventory');
  result.resources.cpu.availableMillis=2*phoneRuntimeResources.cpuMillis+reserve.cpuMillis;
  result.resources.unifiedMemory.availableBytes=2*phoneRuntimeResources.unifiedMemoryBytes+reserve.unifiedMemoryBytes;
  result.resources.network.availableBitsPerSecond=2*phoneRuntimeResources.networkBitsPerSecond+reserve.networkBitsPerSecond;
  if(result.resources.cpu.availableMillis>result.resources.cpu.totalMillis || result.resources.unifiedMemory.availableBytes>result.resources.unifiedMemory.totalBytes)throw Error('physical_capacity_insufficient');
  const capacity=projectManagedNodeLeaseCapacity(result);
  for(const k of ['cpuMillis','unifiedMemoryBytes','networkBitsPerSecond'])if(capacity[k]!==2*phoneRuntimeResources[k])throw Error('phone_capacity_projection_invalid');
  return result;
}

import { PostgresPhoneCapacity } from "../../../../services/scheduler/src/postgres-phone-capacity.mjs";
import { ManagedNodePhoneRuntime } from "./managed-node-phone-runtime.mjs";
import {ManagedNodePhoneFiles} from './managed-node-phone-files.mjs';
import { ManagedPhoneStorageRepository } from '../storage/managed-phone-storage-repository.mjs';
import {PhoneCameraService} from './phone-camera-service.mjs';
import {PostgresPhoneCameraRepository} from './postgres-phone-camera-repository.mjs';
import {ManagedNodePhoneCamera,PostgresPhoneCameraRoutes} from './managed-node-phone-camera.mjs';
import {PhoneObjectTransfer} from './phone-object-transfer.mjs';
import {CAMERA_INPUT} from './phone-camera-contracts.mjs';
import {PhoneUsbCameraService} from './phone-usb-camera-service.mjs';
import {PostgresPhoneUsbCameraPolicy} from './phone-usb-camera-policy.mjs';
import {PhoneUdpCameraService} from './phone-udp-camera-service.mjs';
import {PostgresPhoneUdpCameraPolicy} from './phone-udp-camera-policy.mjs';
import {isIPv4} from 'node:net';
import {readFileSync} from 'node:fs';

export function applianceCameraAddresses(environment) {
  if (!environment.PLATFORM_APPLIANCE_ADDRESSES_FILE) return [applianceCameraAddress(environment)];
  // Network loss/delayed host discovery must not prevent the platform booting.
  // Never fall back to a stale configured IP once automatic mode is enabled.
  try {
    const state = JSON.parse(readFileSync(environment.PLATFORM_APPLIANCE_ADDRESSES_FILE, 'utf8'));
    return [...new Set(state.addresses.filter(address => isIPv4(address)))];
  } catch { return []; }
}

export function applianceCameraAddress(environment) {
  let address=environment.PLATFORM_APPLIANCE_LAN_ADDRESS;
  if(!address && environment.PLATFORM_API_PUBLIC_ORIGIN) {
    try { address=new URL(environment.PLATFORM_API_PUBLIC_ORIGIN).hostname; } catch {}
  }
  if(!isIPv4(address??'') || !/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(address)) {
    throw TypeError('Network camera input requires this appliance LAN IPv4 address');
  }
  return address;
}

export function phoneCapacityFromEnvironment({ environment, database, nodeAgentRouter }) {
  const approvedNodes=phoneNodesFromEnvironment(environment);
  if (approvedNodes===null) return null;
  return new PostgresPhoneCapacity({ database, localNodeId: environment.PLATFORM_APPLIANCE_NODE_ID, approvedNodes,
    storageProvider: { read: input => nodeAgentRouter.readPhoneStorage({ ...input, correlationId: "phone-storage-observation" }) } });
}

export function phoneStorageRepositoryFromEnvironment({ environment, database, nodeAgentRouter, repository }) {
  const approvedNodes = phoneNodesFromEnvironment(environment);
  return approvedNodes === null || !repository?.bindContext ? repository
    : new ManagedPhoneStorageRepository({ repository, database, nodeAgentRouter, localNodeId: environment.PLATFORM_APPLIANCE_NODE_ID, approvedNodes });
}

function phoneNodesFromEnvironment(environment) {
  const configuration = environment.PLATFORM_VIRTUAL_PHONE_NODES_JSON;
  if (configuration === undefined) return null;
  if (typeof configuration !== "string" || Buffer.byteLength(configuration) > 65536) throw new TypeError("Phone node configuration is invalid");
  let approvedNodes;
  try { approvedNodes = JSON.parse(configuration); } catch { throw new TypeError("Phone node configuration must be JSON"); }
  if (!Array.isArray(approvedNodes) || approvedNodes.length !== 1
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(environment.PLATFORM_APPLIANCE_NODE_ID ?? "")
      || approvedNodes[0]?.nodeId !== environment.PLATFORM_APPLIANCE_NODE_ID) {
    throw new TypeError("Phone services require exactly this appliance installation");
  }
  return approvedNodes;
}

export function phoneFilesFromEnvironment({environment,nodeAgentRouter}) {
  const approvedNodes=phoneNodesFromEnvironment(environment);
  return approvedNodes===null?null:new ManagedNodePhoneFiles({approvedNodes,nodeAgentRouter});
}

// Older installations have no camera table or camera-capable ROM. Merely
// upgrading the API must not query a new table or start renewing camera leases.
export function phoneCameraFromEnvironment({environment,database,directory,objectService,nodeAgentRouter}) {
  const enabled=environment.PLATFORM_VIRTUAL_PHONE_CAMERA_ENABLED;
  if(enabled!==undefined&&!['true','false'].includes(enabled))throw TypeError('PLATFORM_VIRTUAL_PHONE_CAMERA_ENABLED must be true or false');
  if(enabled!=='true')return null;
  const approvedNodes=phoneNodesFromEnvironment(environment);
  if(approvedNodes===null||!approvedNodes.length)throw TypeError('Camera input requires configured phone nodes');
  const usbFlag=environment.PLATFORM_VIRTUAL_PHONE_USB_CAMERA_ENABLED;
  if(usbFlag!==undefined&&!['true','false'].includes(usbFlag))throw TypeError('PLATFORM_VIRTUAL_PHONE_USB_CAMERA_ENABLED must be true or false');
  const udpFlag=environment.PLATFORM_VIRTUAL_PHONE_UDP_CAMERA_ENABLED;
  if(udpFlag!==undefined&&!['true','false'].includes(udpFlag))throw TypeError('PLATFORM_VIRTUAL_PHONE_UDP_CAMERA_ENABLED must be true or false');
  const usbEnabled=usbFlag==='true',udpEnabled=udpFlag==='true',repository=new PostgresPhoneCameraRepository({database,approvedNodes,usbEnabled,udpEnabled});
  const runtime=new ManagedNodePhoneCamera({routes:new PostgresPhoneCameraRoutes({database,approvedNodes}),nodeAgentRouter});
  const usbService=usbEnabled?new PhoneUsbCameraService({repository,directory,runtime,policy:new PostgresPhoneUsbCameraPolicy({database})}):null;
  const udpService=udpEnabled?new PhoneUdpCameraService({repository,directory,policy:new PostgresPhoneUdpCameraPolicy({database}),
    nodeAddresses:async nodeId=>{
      return nodeId===environment.PLATFORM_APPLIANCE_NODE_ID?applianceCameraAddresses(environment):[];
    }}):null;
  return new PhoneCameraService({repository,directory,usbService,udpService,
    objectTransfer:new PhoneObjectTransfer({objectService,maximumBytes:CAMERA_INPUT.maximumVideoBytes}),
    runtime});
}

export function phoneAccessRevoker({accessService,cameraService}) {
  if(!cameraService)return accessService;
  if(typeof accessService?.revokePhoneAccess!=='function')throw TypeError('Phone camera requires the existing phone access service');
  return {async revokePhoneAccess(input){
    // Both revocations must be attempted. A failed camera stop must not leave
    // display/ADB access open, and neither failure may be reported as success.
    const results=await Promise.allSettled([accessService.revokePhoneAccess(input),cameraService.revokePhoneAccess(input)]);
    const failed=results.find(result=>result.status==='rejected');if(failed)throw failed.reason;
    return results[0].value;
  }};
}

export function phoneRuntimeFromEnvironment({environment,nodeAgentRouter,accessRevoker}) {
  const approvedNodes=phoneNodesFromEnvironment(environment);
  if (approvedNodes===null || !accessRevoker) return null;
  return new ManagedNodePhoneRuntime({approvedNodes,nodeAgentRouter,accessRevoker});
}

// Disabled/unconfigured installations do not load the WebSocket dependency or
// create another control service. Lifecycle and media use the same node list.
export async function phoneMediaFromEnvironment({environment,database,nodeAgentRouter}) {
  const approvedNodes=phoneNodesFromEnvironment(environment);
  if(approvedNodes===null)return null;
  const {PostgresPhoneMediaRoutes,ManagedNodePhoneMediaBridge,ManagedNodePhoneSignallingUpstream,ManagedNodePhoneAdbUpstream}=
    await import("./managed-node-phone-media-bridge.mjs");
  const routes=new PostgresPhoneMediaRoutes({database,approvedNodes});
  return {peerBridge:new ManagedNodePhoneMediaBridge({routes,nodeAgentRouter}),
    adbUpstream:new ManagedNodePhoneAdbUpstream({routes,nodeAgentRouter}),
    signallingUpstream:new ManagedNodePhoneSignallingUpstream({routes,nodeAgentRouter})};
}

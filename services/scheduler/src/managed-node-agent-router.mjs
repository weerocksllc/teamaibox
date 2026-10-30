import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { validateAndroidPhoneCommand } from "./android-phone-command.mjs";
import {validatePhoneMediaCommand,validatePhoneMediaResult} from "./android-phone-media-command.mjs";
import {validatePhoneCameraCommand,validatePhoneCameraResult} from './android-phone-camera-command.mjs';
import {validateComputerCommand,validateComputerCommandResult} from './computer-command.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function conflict(code, message) {
  return new PlatformError(code, message, { status: 409, retryable: true });
}


/**
 * Routes privileged worker operations to the authenticated Node Agent selected
 * by the worker's immutable node ID/generation. The connector receives only a
 * DNS identity and certificate pin; job payloads never receive node addresses
 * or transport credentials.
 */
export class ManagedNodeAgentRouter {
  #nodes;
  #connect;
  #localNodeId;

  constructor({ nodeRepository, connectorFactory, localNodeId }) {
    if (typeof nodeRepository?.findNode !== "function" || typeof connectorFactory !== "function") {
      throw new TypeError("managed Node Agent router dependencies are incomplete");
    }
    if (!UUID.test(localNodeId ?? "")) throw new TypeError("Local appliance identity is required");
    this.#localNodeId = localNodeId;
    this.#nodes = nodeRepository;
    this.#connect = connectorFactory;
  }

  async #client({ nodeId, nodeGeneration, starting, retained = false }) {
    if (!UUID.test(nodeId ?? "") || !Number.isSafeInteger(nodeGeneration) || nodeGeneration < 1) {
      throw new TypeError("managed Node Agent route identity is invalid");
    }
    if (nodeId !== this.#localNodeId) throw conflict("appliance_node_mismatch", "仅支持本机运行。");
    const node = await this.#nodes.findNode(nodeId);
    if (!node || node.nodeId !== this.#localNodeId || node.lifecycleState === "removed") throw conflict("managed_node_not_found", "Managed node no longer exists");
    if (node.generation !== nodeGeneration && !(retained && node.generation > nodeGeneration)) throw conflict("stale_node_generation", "Managed node generation changed");
    if (starting ? node.lifecycleState !== "ready" : !new Set(["ready", "draining"]).has(node.lifecycleState)) {
      throw conflict("managed_node_not_ready", "Managed node does not accept this worker operation");
    }
    const client = await this.#connect(Object.freeze({
      nodeId: node.nodeId,
      nodeKey: node.nodeKey,
      nodeGeneration: node.generation,
      ...(retained ? {allowRetainedRuntime: true} : {}),
      expectedCertificateFingerprint: node.certificateFingerprint,
      expectedServerName: node.nodeKey,
      port: 9443,
    }));
    if (!client || ["startWorker", "workerHealth", "workerControl", "stopWorker"].some((method) => typeof client[method] !== "function")) {
      throw new TypeError("managed Node Agent connector returned an incomplete client");
    }
    return client;
  }

  async inspectAppliance({ nodeId, nodeGeneration, correlationId }) {
    const client = await this.#client({ nodeId, nodeGeneration, starting: false });
    try {
      if (typeof client.inspectAppliance !== "function") throw new TypeError("Local agent inspection is unavailable");
      return await client.inspectAppliance({ correlationId });
    } finally { client.close?.(); }
  }

  async startWorker({ worker, authority, correlationId }) {
    if (worker?.nodeId == null || worker?.nodeGeneration == null
        || authority?.nodeGeneration !== worker.nodeGeneration) {
      throw conflict("stale_node_generation", "Worker authority does not match its node generation");
    }
    const client = await this.#client({ nodeId: worker.nodeId, nodeGeneration: worker.nodeGeneration, starting: true });
    try { return await client.startWorker({ worker, authority, correlationId }); }
    finally { client.close?.(); }
  }

  async workerHealth({ workerId, nodeId, authority, correlationId }) {
    const client = await this.#client({ nodeId, nodeGeneration: authority?.nodeGeneration, starting: false, retained: true });
    try { return await client.workerHealth({ workerId, nodeId, authority, correlationId }); }
    finally { client.close?.(); }
  }

  async workerControl({ workerId, nodeId, authority, request, correlationId, timeoutMilliseconds }) {
    const client = await this.#client({ nodeId, nodeGeneration: authority?.nodeGeneration, starting: false, retained: true });
    try { return await client.workerControl({ workerId, request, authority, correlationId, timeoutMilliseconds }); }
    finally { client.close?.(); }
  }

  async stopWorker({ workerId, nodeId, authority, gracePeriodSeconds, correlationId }) {
    const client = await this.#client({ nodeId, nodeGeneration: authority?.nodeGeneration, starting: false });
    try { return await client.stopWorker({ workerId, nodeId, authority, gracePeriodSeconds, correlationId }); }
    finally { client.close?.(); }
  }

  async executeComputerCommand({nodeId,action,payload,correlationId,timeoutMilliseconds}) {
    const selected=validateComputerCommand(action,payload);
    if(nodeId!==selected.nodeId)throw conflict('computer_node_mismatch','电脑与本机不匹配。');
    // Resolve current transport authority by stable node ID. A connection
    // generation must not become the disk, computer or runtime identity.
    const node=await this.#nodes.findNode(nodeId);
    if(!node||node.nodeId!==nodeId)throw conflict('managed_node_not_found','电脑所在的本机暂不可达。');
    const client=await this.#client({nodeId,nodeGeneration:node.generation,starting:['create','start'].includes(action)});
    try {
      if(typeof client.executeComputerCommand!=='function')throw conflict('computer_runtime_unavailable','本机尚未安装虚拟电脑服务。');
      return validateComputerCommandResult(action,selected,await client.executeComputerCommand({action,payload:selected,correlationId,timeoutMilliseconds}));
    } finally {client.close?.();}
  }

  async executeComputerInstallation({nodeId,payload,chunks,signal,correlationId}) {
    const selected=validateComputerCommand('installation',payload);
    if(nodeId!==selected.nodeId)throw TypeError('Computer node mismatch');
    const node=await this.#nodes.findNode(nodeId);
    if(!node||node.nodeId!==nodeId)throw conflict('managed_node_not_found','电脑所在的本机暂不可达。');
    const client=await this.#client({nodeId,nodeGeneration:node.generation,starting:true});
    try {
      if(typeof client.executeComputerInstallation!=='function')throw conflict('computer_installation_unavailable','安装盘服务暂不可用。');
      return validateComputerCommandResult('installation',selected,await client.executeComputerInstallation({payload:selected,chunks,signal,correlationId}));
    }finally{client.close?.();}
  }

  async connectComputerDesktop({nodeId,payload,correlationId,signal,kind}) {
    const selected=validateComputerCommand('inspect',payload);
    if(nodeId!==selected.nodeId||!selected.run?.containerId||!['rdp','console','audio'].includes(kind))throw TypeError('Invalid computer desktop request');
    const node=await this.#nodes.findNode(nodeId);
    if(!node||node.nodeId!==nodeId)throw conflict('managed_node_not_found','电脑所在的本机暂不可达。');
    const client=await this.#client({nodeId,nodeGeneration:node.generation,starting:false});
    let closed=false;const retire=()=>{if(!closed){closed=true;client.close?.();}};
    try {
      if(typeof client.connectComputerDesktop!=='function')throw conflict('computer_desktop_unavailable','本机尚未安装电脑桌面服务。');
      const stream=await client.connectComputerDesktop({payload:selected,correlationId,signal,kind});
      stream.once('close',retire);if(stream.destroyed)retire();return stream;
    }catch(error){retire();throw error;}
  }

  async executePhoneCommand({ nodeId, nodeGeneration, action, payload, correlationId }) {
    const selected = validateAndroidPhoneCommand(action, payload);
    const client = await this.#phoneClient({ nodeId, nodeGeneration, starting: ["start", "provision"].includes(action) });
    try {
      if (typeof client.executePhoneCommand !== "function") throw conflict("phone_runtime_unavailable", "本机未配置手机运行服务。");
      return await client.executePhoneCommand({ action, payload: selected, correlationId });
    } finally { client.close?.(); }
  }

  async resolvePhoneNode({ nodeId, minimumGeneration }) {
    if (!UUID.test(nodeId ?? "") || !Number.isSafeInteger(minimumGeneration) || minimumGeneration < 1) {
      throw new TypeError("Phone node approval is invalid");
    }
    if (nodeId !== this.#localNodeId) throw conflict("appliance_node_mismatch", "仅支持本机运行。");
    const node = await this.#nodes.findNode(nodeId);
    if (!node || node.nodeId !== nodeId || !["ready", "draining"].includes(node.lifecycleState)) {
      throw conflict("managed_node_not_ready", "Managed phone node is not ready");
    }
    if (!Number.isSafeInteger(node.generation) || node.generation < minimumGeneration) {
      throw conflict("stale_node_generation", "Phone node approval cannot move backwards");
    }
    // Installation pins identity and a generation floor. Each command still
    // uses an exact current generation, rechecked by #client before transport.
    return Object.freeze({ nodeId, nodeGeneration: node.generation });
  }

  async #phoneClient({nodeId,nodeGeneration,starting}) {
    // A durable phone run keeps its creation generation. Reconnecting to the
    // same node uses fresh current command authority; the Agent independently
    // matches the stored phone/run/volume and exact original container. This
    // does not relax worker leases or accept old signed command envelopes.
    const current=await this.resolvePhoneNode({nodeId,minimumGeneration:nodeGeneration});
    return this.#client({...current,starting});
  }

  async readComputerBaseline({nodeId,nodeGeneration,correlationId}) {
    const client=await this.#client({nodeId,nodeGeneration,starting:true});
    try {
      if(typeof client.readComputerBaseline!=='function')throw conflict('computer_capacity_unavailable','本机未配置虚拟电脑。');
      return await client.readComputerBaseline({correlationId});
    }finally{client.close?.();}
  }

  async readPhoneBaseline({ nodeId, nodeGeneration, correlationId }) {
    const client = await this.#client({ nodeId, nodeGeneration, starting: true });
    try {
      if (typeof client.readPhoneBaseline !== "function") throw conflict("phone_capacity_unavailable", "Node does not provide a phone baseline");
      return await client.readPhoneBaseline({ correlationId });
    } finally { client.close?.(); }
  }

  async readPhoneStorage({ nodeId, nodeGeneration, correlationId }) {
    const client = await this.#client({ nodeId, nodeGeneration, starting: true });
    try {
      if (typeof client.readPhoneStorage !== "function") throw conflict("phone_storage_unavailable", "本机未配置加密存储查询。");
      return await client.readPhoneStorage({ correlationId });
    } finally { client.close?.(); }
  }

  async readPhoneUsbInventory({nodeId,nodeGeneration,correlationId}) {
    const client=await this.#phoneClient({nodeId,nodeGeneration,starting:true});
    try {
      if(typeof client.readPhoneUsbInventory!=='function')throw conflict('phone_camera_unavailable','本机尚未配置 USB 摄像头。');
      return await client.readPhoneUsbInventory({correlationId});
    }finally{client.close?.();}
  }

  async transferPhoneFile({nodeId,nodeGeneration,payload,chunks,signal,correlationId}) {
    const client=await this.#phoneClient({nodeId,nodeGeneration,starting:true});
    try {
      if(typeof client.transferPhoneFile!=='function')throw conflict('phone_runtime_unavailable','本机尚未配置手机文件服务。');
      return await client.transferPhoneFile({payload,chunks,signal,correlationId});
    }finally{client.close?.();} // TLS handshake is complete; stream owns its socket.
  }

  async executePhoneMedia({nodeId,nodeGeneration,action,payload,correlationId}) {
    const selected=validatePhoneMediaCommand(action,payload);
    const client=await this.#phoneClient({nodeId,nodeGeneration,starting:action==="open"});
    try {
      if(typeof client.executePhoneMedia!=="function")throw conflict("phone_runtime_unavailable","本机未配置手机连接服务。");
      return validatePhoneMediaResult(action,selected,await client.executePhoneMedia({action,payload:selected,correlationId}));
    } finally {client.close?.();}
  }

  async executePhoneCamera({nodeId,nodeGeneration,payload,chunks,signal,correlationId}){
    const selected=validatePhoneCameraCommand(payload);
    const client=await this.#phoneClient({nodeId,nodeGeneration,starting:['open','image','video','usb','browser-offer'].includes(selected.action)});
    try{
      if(typeof client.executePhoneCamera!=='function')throw conflict('phone_camera_runtime_unavailable','本机尚未配置摄像头输入。');
      return validatePhoneCameraResult(selected,await client.executePhoneCamera({payload:selected,chunks,signal,correlationId}));
    }finally{client.close?.();}
  }

  async connectPhoneSignal({nodeId,nodeGeneration,payload,correlationId,createWebSocket,onMessage,onClose,signal}) {
    const selected=validatePhoneMediaCommand("renew",payload),client=await this.#phoneClient({nodeId,nodeGeneration,starting:true});
    let closed=false;const retire=()=>{if(!closed){closed=true;client.close?.();onClose();}};
    try {
      if(typeof client.connectPhoneSignal!=="function")throw conflict("phone_runtime_unavailable","本机未配置手机连接服务。");
      const peer=await client.connectPhoneSignal({payload:selected,correlationId,createWebSocket,onMessage,onClose:retire,signal});
      return {send:value=>peer.send(value),close:()=>{try{peer.close();}finally{retire();}}};
    } catch(error){retire();throw error;}
  }

  async connectPhoneADB({nodeId,nodeGeneration,payload,correlationId,signal}) {
    const selected=validatePhoneMediaCommand("renew",payload);
    if(selected.kind!=="adb")throw TypeError("Invalid phone ADB grant");
    const client=await this.#phoneClient({nodeId,nodeGeneration,starting:true});
    let closed=false;const retire=()=>{if(!closed){closed=true;client.close?.();}};
    try {
      if(typeof client.connectPhoneADB!=="function")throw conflict("phone_runtime_unavailable","本机未配置手机调试服务。");
      const stream=await client.connectPhoneADB({payload:selected,correlationId,signal});
      stream.once("close",retire);if(stream.destroyed)retire();return stream;
    } catch(error){retire();throw error;}
  }

  async maintenancePreflight({ nodeId, nodeGeneration, planId, kind, candidateDigest, requirements, correlationId }) {
    const client = await this.#client({ nodeId, nodeGeneration, starting: false });
    if (typeof client.maintenancePreflight !== "function") {
      client.close?.();
      throw new TypeError("managed Node Agent connector does not support maintenance preflight");
    }
    try {
      return await client.maintenancePreflight({ planId, kind, candidateDigest, requirements,
        authority: { leaseId: planId, fencingToken: 1, nodeGeneration }, correlationId });
    } finally { client.close?.(); }
  }

  async executeProtectedMaintenanceTransaction({ nodeId, nodeGeneration, transactionId, workerIds,
    allowedOperations, operationOrder, maintenanceGeneration, issuedAt, expiresAt, journalRevision,
    targets, correlationId }) {
    const client = await this.#client({ nodeId, nodeGeneration, starting: false });
    if (typeof client.executeProtectedMaintenanceTransaction !== "function") {
      client.close?.();
      throw new TypeError("managed Node Agent connector does not support protected maintenance transactions");
    }
    try {
      return await client.executeProtectedMaintenanceTransaction({
        transactionId, workerIds, allowedOperations, operationOrder, maintenanceGeneration,
        issuedAt, expiresAt, journalRevision, targets,
        authority: { leaseId: transactionId, fencingToken: journalRevision, nodeGeneration },
        correlationId,
      });
    } finally { client.close?.(); }
  }

  async executeProtectedSetTransition({ nodeId, nodeGeneration, transactionId, setId, desiredStateRevision,
    workerIds, allowedOperations, operationOrder, maintenanceGeneration, issuedAt, expiresAt,
    journalRevision, migrationPlanId, migrationPlanDigest, qualificationId, qualificationDigest,
    faultInjection, targets, correlationId }) {
    const client = await this.#client({ nodeId, nodeGeneration, starting: false });
    if (typeof client.executeProtectedSetTransition !== "function") {
      client.close?.();
      throw new TypeError("managed Node Agent connector does not support protected set transitions");
    }
    try {
      return await client.executeProtectedSetTransition({
        transactionId, setId, desiredStateRevision, workerIds, allowedOperations, operationOrder,
        maintenanceGeneration, issuedAt, expiresAt, journalRevision, migrationPlanId, migrationPlanDigest,
        qualificationId, qualificationDigest, faultInjection, targets,
        authority: { leaseId: transactionId, fencingToken: journalRevision, nodeGeneration }, correlationId,
      });
    } finally { client.close?.(); }
  }

  async inspectProtectedSetTransition({ nodeId, nodeGeneration, transactionId, migrationPlanId,
    migrationPlanDigest, qualificationId, qualificationDigest, protectedTargetPolicyDigest,
    mode, faultInjection, correlationId }) {
    const client = await this.#client({ nodeId, nodeGeneration, starting: false });
    if (typeof client.inspectProtectedSetTransition !== "function") {
      client.close?.();
      throw new TypeError("managed Node Agent connector does not support protected set transition inspection");
    }
    try {
      return await client.inspectProtectedSetTransition({
        transactionId, migrationPlanId, migrationPlanDigest, qualificationId, qualificationDigest,
        protectedTargetPolicyDigest, mode, faultInjection, correlationId,
      });
    } finally { client.close?.(); }
  }

  async executeApplianceRuntimeRestart({ nodeId, nodeGeneration, restartId, journalRevision,
    policyDigest, idempotencyKey, issuedAt, deadlineAt, correlationId }) {
    const client = await this.#client({ nodeId, nodeGeneration, starting: false });
    if (typeof client.executeApplianceRuntimeRestart !== "function") {
      client.close?.();
      throw new TypeError("managed Node Agent connector does not support appliance runtime restart");
    }
    try {
      return await client.executeApplianceRuntimeRestart({
        restartId, journalRevision, policyDigest, idempotencyKey, issuedAt, deadlineAt, correlationId,
      });
    } finally { client.close?.(); }
  }
}

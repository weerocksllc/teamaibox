import { createHash, randomUUID } from 'node:crypto';
import { PlatformError } from '../../../../packages/observability/src/index.mjs';
import { validateComputerResources } from '../../../../services/scheduler/src/virtual-computer-capacity.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
export function computerError(code, status = 409) {
  const messages = {
    computer_not_found: '找不到这台电脑。', computer_input_invalid: '请检查电脑名称、系统和资源设置。',
    computer_state_conflict: '电脑状态已更新，请刷新后重试。',
    computer_operation_pending: '上一个操作还在处理中，请稍后再试。',
    computer_stop_required: '请先关闭电脑，再删除它的数据。',
    computer_profile_unavailable: '这个系统暂时不能用于新建电脑。',
    computer_profile_version_conflict: '这个系统版本已存在且内容不同。请为新版本使用新的编号；已有电脑不会被替换。',
    computer_profile_not_installed: '本机尚未安装这个系统版本，或安装内容不匹配。请先完成安装，再开放新建。',
    computer_creation_paused: '管理员已暂停新建和开机。正在运行的电脑不受影响。',
    computer_unclean_shutdown: '上次运行意外退出。数据盘仍保留，可以重新开机；Windows 可能会检查磁盘。',
    computer_run_exited: '电脑在操作完成前已退出。数据盘仍保留，请刷新后重新开机。',
    computer_stored_quota: '已达到管理员设置的电脑数量上限。',
    computer_running_quota: '已达到管理员设置的同时运行数量上限。',
    computer_idempotency_conflict: '此请求编号已用于另一项操作，请刷新后重试。',
    computer_runtime_unavailable: '本机虚拟电脑服务暂时无法连接，数据仍然保留。',
    computer_result_mismatch: '本机返回的电脑状态不一致，尚未确认操作完成。',
  };
  throw new PlatformError(code, messages[code] ?? '虚拟电脑操作暂时无法完成。', { status });
}
export function computerId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) computerError('computer_input_invalid', 400);
  return value.toLowerCase();
}
export function requestKey(value) {
  // This is an HTTP request identifier, not a user resource quota.
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) computerError('computer_input_invalid', 400);
  return value;
}
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) computerError('computer_input_invalid', 400);
}
export function createInput(input) {
  fields(input, ['name', 'profileId', 'resources', 'installationMediaId', 'allowUnverified']);
  if (typeof input.name !== 'string' || !input.name.trim() || /[\u0000-\u001f\u007f]/u.test(input.name)
    || typeof input.profileId !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(input.profileId)) computerError('computer_input_invalid', 400);
  fields(input.resources, ['vcpus', 'memoryGiB', 'diskGiB']);
  for (const v of Object.values(input.resources)) if (!Number.isSafeInteger(v) || v <= 0) computerError('computer_input_invalid', 400);
  if (Object.keys(input.resources).length !== 3) computerError('computer_input_invalid', 400);
  if(input.allowUnverified!==undefined&&(input.installationMediaId===undefined||typeof input.allowUnverified!=='boolean'))computerError('computer_input_invalid',400);
  return { name: input.name.trim(), profileId: input.profileId, resources: {
    vcpus: input.resources.vcpus, memoryGiB: input.resources.memoryGiB, diskGiB: input.resources.diskGiB,
  },...(input.installationMediaId!==undefined?{installationMediaId:computerId(input.installationMediaId),allowUnverified:input.allowUnverified===true}:{}) };
}
export function actionInput(action, input) {
  fields(input, action === 'delete' ? ['expectedRevision', 'confirmDelete'] : ['expectedRevision']);
  if (!['start', 'shutdown', 'delete'].includes(action) || !Number.isSafeInteger(input.expectedRevision)
    || input.expectedRevision < 1 || (action === 'delete' && input.confirmDelete !== true)) computerError('computer_input_invalid', 400);
  return { expectedRevision: input.expectedRevision, ...(action === 'delete' ? { confirmDelete: true } : {}) };
}
export function fingerprint(input) { return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }

export function validateComputerProfile(profile) {
  fields(profile, ['id', 'name', 'version', 'edition', 'runtimeImage', 'mediaDigest', 'firmwareDigest', 'driverDigest', 'minimum', 'tpm', 'secureBoot', 'remoteDesktop', 'rights', 'schemaVersion', 'osFamily', 'architecture']);
  const managedMedia = profile.schemaVersion === 2;
  if (profile.schemaVersion !== undefined && !managedMedia
    || managedMedia && (!['windows', 'linux'].includes(profile.osFamily) || profile.architecture !== 'aarch64'
      || profile.mediaDigest !== null || profile.driverDigest !== null && !DIGEST.test(profile.driverDigest ?? ''))
    || !managedMedia && (profile.osFamily !== undefined || profile.architecture !== undefined)) computerError('computer_profile_unavailable');
  if (!profile.id || !profile.name || !profile.version || !profile.edition
    || !(managedMedia ? ['runtimeImage', 'firmwareDigest'] : ['runtimeImage', 'mediaDigest', 'firmwareDigest', 'driverDigest']).every(k => DIGEST.test(profile[k] ?? ''))
    || typeof profile.tpm !== 'boolean' || typeof profile.secureBoot !== 'boolean' || typeof profile.remoteDesktop !== 'boolean'
    || !profile.rights || typeof profile.rights !== 'object') computerError('computer_profile_unavailable');
  validateComputerResources(profile.minimum, { profile, policy: {} });
  return structuredClone(profile);
}

export function newComputer({ ownerId, input, profile, nodeId, poolId, policy, uuid = randomUUID }) {
  const selected = createInput(input), pinned = validateComputerProfile(profile);
  if (selected.profileId !== pinned.id || typeof poolId !== 'string' || !poolId) computerError('computer_profile_unavailable');
  applyRuntimeUpdate(pinned, policy?.runtimeUpdates?.[pinned.id] ?? null);
  return { id: uuid(), ownerId: computerId(ownerId), name: selected.name,
    profile: pinned, resources: validateComputerResources(selected.resources, { profile: pinned, policy }),
    nodeId: computerId(nodeId), poolId, volumeId: uuid(), firmwareId: uuid(), tpmId: pinned.tpm ? uuid() : null,
    state: 'creating', revision: 1, generation: 0, run: null, errorCode: null };
}

export function applyRuntimeUpdate(profile, update) {
  if (update === null) return;
  const from = Array.isArray(update?.from) ? update.from : [update?.from];
  if (!update || Object.keys(update).sort().join(',') !== 'from,to'
    || !from.length || from.some(value => !DIGEST.test(value)) || new Set(from).size !== from.length
    || !DIGEST.test(update.to) || from.includes(update.to)
    || ![...from, update.to].includes(profile.runtimeImage)) computerError('computer_profile_unavailable');
  profile.runtimeImage = update.to;
}

/** Durable identity deliberately excludes transport connection IDs and node
 * reconnect generations. Current command authentication is resolved separately.
 * Each operation/run ID is allocated and committed before any node side effect.
 */
export function beginComputerOperation(computer, action, input, { uuid = randomUUID, runtimeUpdate = null } = {}) {
  const c = structuredClone(computer);
  if (action !== 'create') {
    const request = actionInput(action, input);
    if (request.expectedRevision !== c.revision) computerError('computer_state_conflict');
    if (action === 'start') {
      if (c.state !== 'stopped' || c.run !== null) computerError('computer_state_conflict');
      // An installed maintenance update may replace only the host runtime,
      // never the guest template, disk, firmware, TPM or account. Each run and
      // operation retains the exact image it actually used.
      applyRuntimeUpdate(c.profile, runtimeUpdate);
      c.generation++;
      c.run = { id: uuid(), generation: c.generation, containerId: null, runtimeImage: c.profile.runtimeImage };
      c.state = 'starting';
    } else if (action === 'shutdown') {
      if (!c.run || !['running', 'unavailable', 'error'].includes(c.state)) computerError('computer_state_conflict');
      c.state = 'stopping';
    } else {
      if (c.run || !['stopped','error'].includes(c.state)) computerError('computer_stop_required');
      c.state = 'deleting';
    }
    c.revision++;
  } else if (c.state !== 'creating') computerError('computer_state_conflict');
  c.errorCode = null;
  const op = { id: uuid(), computerId: c.id, ownerId: c.ownerId, action, state: 'queued', generation: c.generation,
    command: { computerId: c.id, ownerId: c.ownerId, nodeId: c.nodeId, poolId: c.poolId,
      volumeId: c.volumeId, firmwareId: c.firmwareId, tpmId: c.tpmId, generation: c.generation,
      profile: structuredClone(c.profile), resources: structuredClone(c.resources), run: structuredClone(c.run) } };
  return { computer: c, operation: op };
}

export function completeComputerOperation(computer, operation, result) {
  const c = structuredClone(computer), command = operation.command;
  const equal = k => JSON.stringify(result?.[k]) === JSON.stringify(command[k]);
  const expectedState={create:'creating',start:'starting',shutdown:'stopping',delete:'deleting'}[operation.action];
  if (operation.computerId !== c.id || operation.ownerId !== c.ownerId || operation.generation !== c.generation
    || result?.operationId !== operation.id
    || !['computerId', 'ownerId', 'nodeId', 'volumeId', 'firmwareId', 'tpmId', 'generation'].every(equal)
    || ['volumeId','firmwareId','tpmId','nodeId'].some(k=>command[k]!==c[k])
    || c.state!==expectedState || command.run?.id!==c.run?.id) computerError('computer_result_mismatch');
  if (result.rejected === true) {
    // Only a verified no-effect rejection is terminal. A timeout, lost response
    // or partially created volume must be reconciled with the same operation.
    if (result.noSideEffects !== true || !['computer_capacity_unavailable','computer_storage_unavailable',
      'computer_profile_unavailable','computer_permission_required'].includes(result.errorCode)) computerError('computer_result_mismatch');
    if (operation.action==='start') { c.state='stopped';c.run=null; }
    else if(operation.action==='create') c.state='error';
    else if(operation.action==='shutdown') c.state='running';
    else if(operation.action==='delete') c.state='stopped';
    else computerError('computer_result_mismatch');
    c.errorCode=result.errorCode;c.revision++;return c;
  }
  if (operation.action === 'create') {
    if (c.state !== 'creating' || result.provisioned !== true || result.encryption !== 'luks2') computerError('computer_result_mismatch');
    c.state = 'stopped';
  } else if (operation.action === 'start') {
    if (c.state !== 'starting' || result.running !== true || result.runId !== c.run?.id
      || result.runtimeImage !== c.profile.runtimeImage || !/^[a-f0-9]{64}$/.test(result.containerId ?? '')) computerError('computer_result_mismatch');
    c.run.containerId = result.containerId; c.state = 'running';
  } else if (operation.action === 'shutdown') {
    if (c.state !== 'stopping' || result.stopped !== true || result.runId !== c.run?.id
      || result.containerId !== c.run.containerId || result.cleanShutdown !== true) computerError('computer_result_mismatch');
    c.run = null; c.state = 'stopped';
  } else if (operation.action === 'delete') {
    if (c.state !== 'deleting' || c.run !== null || result.dataDeleted !== true) computerError('computer_result_mismatch');
    c.state = 'deleted';
  } else computerError('computer_result_mismatch');
  c.errorCode = null; c.revision++;
  return c;
}

export function publicComputer(c) {
  return { id: c.id, name: c.name, state: c.state, revision: c.revision,
    system: { id: c.profile.id, name: c.profile.name, edition: c.profile.edition,
      installable:c.profile.schemaVersion===2,osFamily:c.profile.osFamily??'windows' },
    resources: c.resources, errorCode: c.errorCode, closePageStopsComputer: false };
}

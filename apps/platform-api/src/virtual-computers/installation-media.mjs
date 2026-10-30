import {computerError, computerId, requestKey} from './lifecycle.mjs';

const fields = (value, allowed) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)))
    computerError('computer_input_invalid', 400);
};
export function mediaImportInput(input) {
  fields(input, ['source', 'referenceId', 'fileId', 'version', 'name']);
  if (typeof input.name !== 'string' || !input.name.trim() || /[\u0000-\u001f\u007f/\\]/u.test(input.name))
    computerError('computer_input_invalid', 400);
  const name = input.name.trim().normalize('NFC');
  if (input.source === 'upload' && input.fileId === undefined && input.version === undefined)
    return {source: 'upload', name, referenceId: computerId(input.referenceId)};
  if (input.source === 'drive' && input.referenceId === undefined && Number.isSafeInteger(input.version) && input.version > 0)
    return {source: 'drive', name, fileId: computerId(input.fileId), version: input.version};
  computerError('computer_input_invalid', 400);
}

export function installationActionInput(action, input) {
  fields(input, ['expectedRevision', ...(action === 'mount' ? ['mediaId', 'allowUnverified'] : [])]);
  if (!['mount', 'eject', 'boot-disc', 'cancel-boot', 'installed', 'adopt'].includes(action)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) computerError('computer_input_invalid', 400);
  if (action !== 'mount') return {expectedRevision: input.expectedRevision};
  if (input.allowUnverified !== undefined && typeof input.allowUnverified !== 'boolean') computerError('computer_input_invalid', 400);
  return {expectedRevision: input.expectedRevision, mediaId: computerId(input.mediaId), allowUnverified: input.allowUnverified === true};
}

export function requireMountableMedia(media, ownerId, {allowUnverified = false} = {}) {
  // Do not disclose another member's filename or its existence.
  if (!media || media.ownerId !== ownerId || media.state === 'deleted') computerError('computer_media_not_found', 404);
  if (media.state !== 'ready') computerError('computer_media_not_ready');
  if (media.compatibility === 'wrong-architecture') computerError('computer_media_wrong_architecture');
  if (['invalid', 'not-bootable'].includes(media.compatibility)) computerError('computer_media_not_bootable');
  if (!['arm64', 'unverified'].includes(media.compatibility)) computerError('computer_media_not_ready');
  if (media.compatibility === 'unverified' && !allowUnverified) computerError('computer_media_confirmation_required');
  if (!/^sha256:[a-f0-9]{64}$/.test(media.digest ?? '') || !Number.isSafeInteger(media.size) || media.size < 1)
    computerError('computer_media_not_ready');
  return media;
}

// Kept separately from computer power state and permanent disk identity. An
// absent installation row on an old computer means "legacy", never "empty".
export function initialInstallation() {
  return {phase: 'empty', desiredMediaId: null, observedMediaId: null, revision: 1,
    observedRevision: 1, boot: null};
}
export function requestDiscBoot(installation, {operationId, nextGeneration}) {
  if (!installation?.desiredMediaId || installation.desiredMediaId !== installation.observedMediaId
    || installation.revision !== installation.observedRevision) computerError('computer_media_not_ready');
  if (!Number.isSafeInteger(nextGeneration) || nextGeneration < 1) computerError('computer_input_invalid', 400);
  const id = computerId(operationId);
  if (installation.boot?.id === id) return structuredClone(installation); // Includes consumed: never re-arm a replay.
  if (installation.boot && ['pending', 'armed'].includes(installation.boot.state)) computerError('computer_operation_pending');
  return {...structuredClone(installation), boot: {id, mediaId: installation.desiredMediaId, generation: nextGeneration, state: 'pending'}};
}
export function observeDiscBoot(installation, {operationId, generation, state}) {
  if (!['armed', 'consumed'].includes(state) || installation?.boot?.id !== computerId(operationId)
    || installation.boot.generation !== generation) computerError('computer_result_mismatch');
  const current = installation.boot.state;
  if (current === state || current === 'consumed' && state === 'armed') return structuredClone(installation);
  if (!(['pending', 'armed'].includes(current) && state === 'consumed' || current === 'pending' && state === 'armed'))
    computerError('computer_state_conflict');
  return {...structuredClone(installation), boot: {...installation.boot, state}};
}

export function importIdentity(ownerId, key, input) {
  return {ownerId: computerId(ownerId), key: requestKey(key), input: mediaImportInput(input)};
}

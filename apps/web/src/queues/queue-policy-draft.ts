import type { QueueAdministration, QueuePolicyInput } from "./queue-administration-client";

export const editableKeys: Array<keyof QueuePolicyInput> = ["minimumPriority", "maximumPriority", "maxQueuedPerOwner", "maxActivePerOwner", "maxQueuedPerCapability", "maxDailySubmissionsPerOwner", "maxRequestBytes", "maxDeadlineSeconds"];

export function policyInput(value: QueueAdministration["policy"]): QueuePolicyInput {
  return Object.fromEntries(editableKeys.map(key => [key, value[key]])) as QueuePolicyInput;
}

/** Refresh live job counts without silently rebasing an unsaved policy edit. */
export function preservePolicyBaseline(next: QueueAdministration, current: QueueAdministration | null, dirty: boolean): QueueAdministration {
  return dirty && current ? { ...next, policy: current.policy } : next;
}

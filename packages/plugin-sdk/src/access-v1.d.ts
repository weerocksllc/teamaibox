export type DelegatedPlatformScopeV1 =
  | "ai:invoke"
  | "files:read"
  | "files:write"
  | "messages:read"
  | "messages:write"
  | "tasks:read"
  | "tasks:manage"
  | "team:read";

export interface DelegatedResourceV1 {
  readonly kind: "appliance" | "team";
  readonly key: string;
}

export interface DelegatedGrantRequestV1 {
  readonly scope: DelegatedPlatformScopeV1;
  readonly resource: DelegatedResourceV1;
}

/**
 * A short-lived, in-memory launch credential. Applications must never persist,
 * log, place in a URL, or forward this value to a different plugin audience.
 */
export interface ApplicationPluginDelegationV1 {
  readonly token: `taibp_v1_${string}`;
  readonly delegationId: string;
  readonly audience: `plugin:${string}`;
  readonly grants: readonly DelegatedGrantRequestV1[];
  readonly issuedAt: string;
  readonly expiresAt: string;
}

export interface DelegatedPlatformRequestV1<TBody = unknown> {
  readonly scope: DelegatedPlatformScopeV1;
  readonly resource: DelegatedResourceV1;
  readonly operation: string;
  readonly body?: TBody;
  readonly idempotencyKey?: string;
}

export interface ApplicationPluginPlatformClientV1 {
  request<TResponse = unknown, TBody = unknown>(
    input: DelegatedPlatformRequestV1<TBody>,
  ): Promise<TResponse>;
}

/**
 * Compute plugins report this claim in the fenced worker-control channel.
 * Only the scheduler can turn it into a registry entry; there is deliberately
 * no public direct-register API or user credential member.
 */
export interface ComputeWorkerCapabilityClaimV1 {
  readonly modelProfileId: string;
  readonly operations: readonly string[];
}

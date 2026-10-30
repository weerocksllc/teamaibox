import { Buffer } from "node:buffer";

import { PlatformError } from "../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALIAS = /^[a-z][a-z0-9_.-]{2,127}$/;
const TOKEN_TARGET = "/run/secrets/teamaibox-model-token";
const CONFIG_TARGET = "/run/teamaibox/xdg-config/opencode/opencode.json";
const MODEL_PROXY_ORIGIN = "http://127.0.0.1:4095/v1";
const MODEL_PROXY_API_KEY = "local-proxy";
const PROVIDER_ID = "teamaibox";
const SCOPES = Object.freeze(["openai:chat.completions", "openai:responses"]);
const LOCAL_PROXY_OPTIONS = Object.freeze({ apiKey: MODEL_PROXY_API_KEY, baseURL: MODEL_PROXY_ORIGIN });
const DIRECT_COMPONENT_OPTIONS = Object.freeze({
  apiKey: `{file:${TOKEN_TARGET}}`,
  baseURL: "http://compute-gateway:8080/v1",
});

function closedProviderOptions(value = LOCAL_PROXY_OPTIONS) {
  const matches = [LOCAL_PROXY_OPTIONS, DIRECT_COMPONENT_OPTIONS].some((candidate) => (
    value?.apiKey === candidate.apiKey && value?.baseURL === candidate.baseURL
    && Object.keys(value).length === 2
  ));
  if (!matches) throw new PlatformError("agent_model_provider_invalid", "Agent model provider route is invalid", { status: 400 });
  return Object.freeze({ apiKey: value.apiKey, baseURL: value.baseURL });
}

function aliases(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 64) {
    throw new PlatformError("agent_model_alias_invalid", "Agent model aliases are invalid", { status: 400 });
  }
  const normalized = [...new Set(values)];
  if (normalized.length !== values.length || normalized.some((value) => typeof value !== "string" || !ALIAS.test(value))) {
    throw new PlatformError("agent_model_alias_invalid", "Agent model aliases are invalid", { status: 400 });
  }
  return normalized.sort();
}

function modelDefinition(value) {
  if (!value || typeof value.alias !== "string" || !ALIAS.test(value.alias)
    || typeof value.displayName !== "string" || !value.displayName.trim() || value.displayName.length > 160
    || !Number.isSafeInteger(value.contextTokens) || value.contextTokens < 1024
    || !Number.isSafeInteger(value.outputTokens) || value.outputTokens < 1 || value.outputTokens > value.contextTokens
    || value.approvedForAgent !== true) {
    throw new PlatformError("agent_model_catalog_invalid", "Approved Agent model catalog is invalid", { status: 502 });
  }
  return value;
}

function generatedConfig(models, defaultAlias, providerOptions = LOCAL_PROXY_OPTIONS) {
  const options = closedProviderOptions(providerOptions);
  const configured = Object.fromEntries(models.map((model) => [model.alias, {
    id: model.alias,
    name: model.displayName,
    tool_call: true,
    limit: { context: model.contextTokens, output: model.outputTokens },
  }]));
  return Object.freeze({
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    autoshare: false,
    plugin: [],
    permission: "ask",
    enabled_providers: [PROVIDER_ID],
    model: `${PROVIDER_ID}/${defaultAlias}`,
    small_model: `${PROVIDER_ID}/${defaultAlias}`,
    provider: {
      [PROVIDER_ID]: {
        name: "Team AI Box",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: configured,
        options,
      },
    },
  });
}

function credentialFacts(value, { ownerIdentityId, sandboxId, modelAliases, now, maximumExpiry }) {
  if (!value || typeof value.token !== "string" || value.token.length < 32 || value.token.length > 8192 || /[\s\0]/.test(value.token)
    || typeof value.tokenId !== "string" || !UUID.test(value.tokenId)
    || !(value.expiresAt instanceof Date) || value.expiresAt <= now || value.expiresAt > maximumExpiry
    || value.subject !== ownerIdentityId || value.sandboxId !== sandboxId || value.audience !== "compute.openai"
    || JSON.stringify(value.scopes) !== JSON.stringify(SCOPES)
    || JSON.stringify(value.modelAliases) !== JSON.stringify(modelAliases)) {
    throw new PlatformError("agent_model_credential_invalid", "Agent model credential issuer returned invalid scope", { status: 502 });
  }
  return value;
}

export class AgentModelAccessService {
  #catalog;
  #issuer;
  #projector;
  #clock;
  #audit;
  #providerOptions;

  constructor({ catalog, credentialIssuer, sandboxProjector, clock = () => new Date(), audit = async () => {}, openCodeProviderOptions = LOCAL_PROXY_OPTIONS }) {
    if (!catalog?.listApprovedAgentModels || !credentialIssuer?.issue
      || !sandboxProjector?.projectSecret || !sandboxProjector?.projectConfig
      || typeof clock !== "function" || typeof audit !== "function") {
      throw new TypeError("Agent model access dependencies are incomplete");
    }
    this.#catalog = catalog;
    this.#issuer = credentialIssuer;
    this.#projector = sandboxProjector;
    this.#clock = clock;
    this.#audit = audit;
    this.#providerOptions = closedProviderOptions(openCodeProviderOptions);
  }

  async provision({ ownerIdentityId, sandboxId, requestedAliases, defaultAlias, ttlSeconds = 300 }) {
    if (typeof ownerIdentityId !== "string" || !UUID.test(ownerIdentityId)
      || typeof sandboxId !== "string" || !UUID.test(sandboxId)
      || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 300) {
      throw new PlatformError("agent_model_access_invalid", "Agent model access request is invalid", { status: 400 });
    }
    const requested = aliases(requestedAliases);
    if (typeof defaultAlias !== "string" || !requested.includes(defaultAlias)) {
      throw new PlatformError("agent_model_alias_invalid", "Default Agent model alias is not requested", { status: 400 });
    }
    const approved = new Map((await this.#catalog.listApprovedAgentModels(ownerIdentityId)).map((value) => {
      const model = modelDefinition(value);
      return [model.alias, model];
    }));
    const models = requested.map((alias) => approved.get(alias));
    if (models.some((model) => !model)) {
      throw new PlatformError("agent_model_not_approved", "Agent requested a model alias that is not approved", { status: 403 });
    }
    const now = this.#clock();
    const maximumExpiry = new Date(now.getTime() + ttlSeconds * 1000);
    const credential = credentialFacts(await this.#issuer.issue({
      subject: ownerIdentityId,
      sandboxId,
      audience: "compute.openai",
      scopes: SCOPES,
      modelAliases: requested,
      expiresAt: maximumExpiry,
      singleSandbox: true,
    }), { ownerIdentityId, sandboxId, modelAliases: requested, now, maximumExpiry });
    const config = generatedConfig(models, defaultAlias, this.#providerOptions);
    const encoded = Buffer.from(JSON.stringify(config, null, 2) + "\n");
    const secret = Buffer.from(credential.token);
    try {
      await this.#projector.projectConfig({
        sandboxId,
        ownerIdentityId,
        target: CONFIG_TARGET,
        contents: encoded,
        mode: 0o444,
        ownerUid: 0,
        ownerGid: 0,
        immutableProviderSet: true,
      });
      await this.#projector.projectSecret({
        sandboxId,
        ownerIdentityId,
        tokenId: credential.tokenId,
        target: TOKEN_TARGET,
        contents: secret,
        mode: 0o400,
        ownerUid: 65532,
        ownerGid: 65532,
        expiresAt: credential.expiresAt,
        ephemeralMountRequired: true,
      });
    } finally {
      secret.fill(0);
    }
    await this.#audit({
      action: "agent.model_access_provisioned",
      ownerIdentityId,
      sandboxId,
      tokenId: credential.tokenId,
      modelAliases: requested,
      scopes: SCOPES,
      expiresAt: credential.expiresAt.toISOString(),
      occurredAt: now.toISOString(),
    });
    return Object.freeze({
      providerId: PROVIDER_ID,
      defaultModel: Object.freeze({ providerId: PROVIDER_ID, modelId: defaultAlias }),
      modelAliases: Object.freeze(requested),
      tokenId: credential.tokenId,
      expiresAt: credential.expiresAt.toISOString(),
      configTarget: CONFIG_TARGET,
      secretTarget: TOKEN_TARGET,
    });
  }
}

export const agentOpenCodeConfig = generatedConfig;
export const directAgentComponentProviderOptions = DIRECT_COMPONENT_OPTIONS;

import { PlatformError } from "../../../../packages/observability/src/index.mjs";

function invalid() {
  return new PlatformError("invalid_credential", "Credential is invalid or expired", { status: 401 });
}

export class RoutedCredentialAuthentication {
  #agent;
  #api;

  constructor({ agent = null, api = null }) {
    if ((agent !== null && typeof agent.authenticate !== "function")
      || (api !== null && typeof api.authenticate !== "function") || (!agent && !api)) {
      throw new TypeError("routed credential authentication is incomplete");
    }
    this.#agent = agent;
    this.#api = api;
  }

  async authenticate(input) {
    if (typeof input?.secret !== "string") throw invalid();
    if (input.secret.startsWith("taib_agent_v1.")) {
      if (!this.#agent) throw invalid();
      return this.#agent.authenticate(input);
    }
    if (input.secret.startsWith("taib_sk_")) {
      if (!this.#api) throw invalid();
      return this.#api.authenticate(input);
    }
    throw invalid();
  }
}

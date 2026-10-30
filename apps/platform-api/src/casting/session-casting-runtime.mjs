import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function browserOnly(value) {
  if (!Array.isArray(value) || value.length !== 1 || value[0] !== "browser") {
    throw new PlatformError("cast_output_invalid", "Casting is available only in the browser", { status: 400 });
  }
}

/** Serializes one session's operations without booking shared CPU or memory.
 * Ownership, permissions and durable stop retries remain in the session service.
 */
export class SessionCastingRuntime {
  #runtime; #nodeIdentity; #pending = new Map();
  constructor({ runtime, nodeIdentity }) {
    if (["startReceiver", "stopReceiver", "updateReceiver", "health", "readiness",
      "issueViewerConnection", "disconnectViewer"].some(key => typeof runtime?.[key] !== "function")
      || !UUID.test(nodeIdentity?.nodeId ?? "") || !Number.isSafeInteger(nodeIdentity?.nodeGeneration)
      || nodeIdentity.nodeGeneration < 1) throw new TypeError("Casting runtime identity is required");
    this.#runtime = runtime;
    this.#nodeIdentity = Object.freeze({ ...nodeIdentity });
  }
  #serial(sessionId, action) {
    if (!UUID.test(sessionId ?? "")) throw new TypeError("Casting session identity is invalid");
    const previous = this.#pending.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.#pending.set(sessionId, current);
    void current.finally(() => {
      if (this.#pending.get(sessionId) === current) this.#pending.delete(sessionId);
    }).catch(() => {});
    return current;
  }
  startReceiver(input) {
    return this.#serial(input?.sessionId, () => {
      browserOnly(input.outputSinks);
      return this.#runtime.startReceiver(input);
    });
  }
  stopReceiver(input) { return this.#serial(input?.sessionId, () => this.#runtime.stopReceiver(input)); }
  updateReceiver(input) {
    return this.#serial(input?.sessionId, () => {
      browserOnly(input.outputSinks);
      return this.#runtime.updateReceiver(input);
    });
  }
  readiness() { return this.#runtime.readiness(this.#nodeIdentity); }
  health(input) { return this.#runtime.health(input); }
  issueViewerConnection(input) { return this.#runtime.issueViewerConnection(input); }
  disconnectViewer(input) { return this.#runtime.disconnectViewer(input); }
  consumeViewerConnection(input) { return this.#runtime.consumeViewerConnection(input); }
}

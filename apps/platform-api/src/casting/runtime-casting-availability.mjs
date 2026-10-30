import { PlatformError } from "../../../../packages/observability/src/index.mjs";

// A deployment flag is not a readiness fact. Query the actual private runtime
// and require the callback listener and (for browser) authenticated signalling.
// Capacity remains transactionally rechecked by ReservationBoundCastingRuntime
// immediately before start, so this display-only read never acquires a lease.
export class RuntimeCastingAvailability {
  #runtime; #callback; #signalling;
  constructor({ runtime, callback, signallingEnabled }) {
    if (typeof runtime?.readiness !== "function" || typeof callback?.listening !== "function"
      || typeof signallingEnabled !== "boolean") throw new TypeError("Casting activation requires live control boundaries");
    this.#runtime = runtime; this.#callback = callback; this.#signalling = signallingEnabled;
  }
  async status() {
    const result = { schemaVersion: 1, object: "cast.availability", mode: "runtime", state: "unknown",
      receiverReady: false, sessionStartAllowed: false, receiverAdvertisementAllowed: false,
      outputs: { browser: { state: "unavailable", reasonCode: "cast_media_runtime_unavailable" } }, gates: [],
      limitations: { appleCertified: false, fairPlayDrmSupported: false, syntheticAcceptanceAllowed: false },
      successor: { atomicCutoverRequired: true } };
    let code = "cast_callback_unavailable";
    if (this.#callback.listening()) {
      code = "cast_media_runtime_unavailable";
      try {
        const facts = await this.#runtime.readiness();
        for (const sink of ["browser"]) {
          const value = facts.outputs[sink];
          result.outputs[sink] = { state: value.available ? "available" : "unavailable", reasonCode: value.reasonCode };
        }
        if (!this.#signalling) result.outputs.browser = { state: "unavailable", reasonCode: "cast_signalling_unavailable" };
        if (this.#callback.listening() && Object.values(result.outputs).some(value => value.state === "available")) {
          result.state = "ready";
          result.receiverReady = result.sessionStartAllowed = result.receiverAdvertisementAllowed = true;
          return result;
        }
      } catch { /* Never expose private endpoint, certificate or upstream error. */ }
    }
    result.gates.push({ code, category: "runtime", state: "blocked" });
    return result;
  }
  async assertSessionStartAllowed({ outputSinks } = {}) {
    const value = await this.status();
    if (value.sessionStartAllowed && (!outputSinks || outputSinks.every(sink => value.outputs[sink]?.state === "available"))) return;
    const gateCodes = [...new Set([...value.gates.map(g => g.code), ...(outputSinks ?? [])
      .filter(sink => value.outputs[sink]?.state !== "available")
      .map(sink => value.outputs[sink]?.reasonCode ?? "cast_output_unavailable")])];
    throw new PlatformError("cast_capability_unavailable", "Selected casting outputs are not ready", {
      status: 503, retryable: true, details: { state: value.state, receiverReady: value.receiverReady, startAllowed: false, gateCodes },
    });
  }
}

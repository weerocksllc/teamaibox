export class WorkerObservabilityEventSink {
  #downstream; #diagnostics; #onError;
  constructor({ downstream, diagnostics, onError = () => {} }) {
    if (typeof downstream?.publish !== "function" || typeof diagnostics?.recordWorkerLifecycleEvent !== "function" || typeof onError !== "function") {
      throw new TypeError("worker observability event sink dependencies are incomplete");
    }
    this.#downstream = downstream; this.#diagnostics = diagnostics; this.#onError = onError;
  }
  async publish(event) {
    await this.#downstream.publish(event);
    try { await this.#diagnostics.recordWorkerLifecycleEvent(event); }
    catch (error) { await this.#onError(error, event); }
  }
}

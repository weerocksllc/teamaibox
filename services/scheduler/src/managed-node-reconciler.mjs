export class ManagedNodeReconciler {
  #service; #intervalMs; #timer = null; #active = null; #onError; #clock;
  #lastObservation = null; #resumePending = false;
  constructor({ service, intervalMilliseconds = 15_000, onError = () => {}, clock = () => performance.now() }) {
    if (typeof service?.reconcileStale !== "function" || !Number.isSafeInteger(intervalMilliseconds) || intervalMilliseconds < 1_000 || intervalMilliseconds > 30_000 || typeof onError !== "function" || typeof clock !== "function") throw new TypeError("Managed node reconciler configuration is invalid");
    this.#service = service; this.#intervalMs = intervalMilliseconds; this.#onError = onError; this.#clock = clock;
  }
  async reconcileNow() {
    if (this.#active) return this.#active;
    const now = this.#clock();
    // Missing a whole observation interval means the controller itself was
    // unavailable (pause/event-loop starvation). Reuse the cold-start gate:
    // saved ready nodes cannot accept new work before a fresh heartbeat, and
    // the original bounded stale window still fences genuinely absent nodes.
    if (this.#lastObservation !== null && now - this.#lastObservation > 2 * this.#intervalMs
        && typeof this.#service.beginObservationWindow === "function") this.#resumePending = true;
    this.#lastObservation = now;
    const observe = () => this.#service.reconcileStale();
    const reset = this.#resumePending ? this.#service.beginObservationWindow({ restartObservation: true }) : null;
    this.#active = (reset ? Promise.resolve(reset).then(() => { this.#resumePending = false; return observe(); }) : observe())
      .catch((error) => { this.#onError(error); return { fenced: [] }; }).finally(() => { this.#active = null; });
    return this.#active;
  }
  start() {
    if (this.#timer) return;
    void this.reconcileNow();
    this.#timer = setInterval(() => { void this.reconcileNow(); }, this.#intervalMs);
    this.#timer.unref?.();
  }
  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = null; this.#lastObservation = null; }
}

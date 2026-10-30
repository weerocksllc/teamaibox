/** One in-flight request. Schedule the next refresh only after this one settles. */
export function startSerialRefresh({ request, onValue, onError,
  intervalMilliseconds = 15_000, timeoutMilliseconds = 12_000,
  schedule = globalThis.setTimeout, unschedule = globalThis.clearTimeout }) {
  let stopped = false, nextTimer, deadlineTimer, controller;
  async function refresh() {
    controller = new AbortController();
    deadlineTimer = schedule(() => controller.abort(), timeoutMilliseconds);
    try {
      const value = await request(controller.signal);
      if (!stopped && !controller.signal.aborted) onValue(value);
    } catch (error) {
      if (!stopped) onError(error);
    } finally {
      unschedule(deadlineTimer);
      if (!stopped) nextTimer = schedule(refresh, intervalMilliseconds);
    }
  }
  void refresh();
  return () => {
    stopped = true;
    unschedule(nextTimer);
    unschedule(deadlineTimer);
    controller.abort();
  };
}

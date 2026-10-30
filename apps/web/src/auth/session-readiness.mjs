// This endpoint reports readiness once; it is not an application subscription.
// Holding it open in every tab exhausts HTTP/1.1's per-origin connection pool.
// Actual application streams and the session WebSocket have their own lifetime.
export function observeSessionReadiness({ EventSourceClass, onState }) {
  const events = new EventSourceClass("/events/session?once=1");
  let finished = false;
  const finish = (state) => {
    if (finished) return;
    finished = true;
    events.close();
    onState(state);
  };
  events.addEventListener("session.ready", () => finish("ready"));
  // EventSource otherwise reconnects automatically even after a one-shot EOF.
  events.onerror = () => finish("error");
  return () => {
    finished = true;
    events.close();
  };
}

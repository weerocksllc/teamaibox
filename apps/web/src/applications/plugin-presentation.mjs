/** Content-free startup handshake. Never reloads an initialized application or probes its APIs. */
export function inspectPluginPresentation(frame, source, origin) {
  try {
    const doc = frame?.contentDocument;
    if (!doc) return { state: "unavailable", locale: null };
    if (doc.URL === "about:blank") return { state: "blank", locale: null };
    const actual = new URL(doc.URL), expected = new URL(source, origin);
    if (actual.origin !== expected.origin || actual.pathname !== expected.pathname) {
      return { state: "different", locale: null };
    }
    return { state: doc.readyState === "loading" ? "loading" : "loaded",
      locale: doc.documentElement?.dataset.uiPresentedLocale ?? null };
  } catch { return { state: "unavailable", locale: null }; }
}

export function watchPluginPresentation({ frame, source, origin, locale, publish, onReady, onFailure,
  onDocumentState = (_state) => {}, schedule = setTimeout, cancel = clearTimeout, maximumAttempts = 32 }) {
  let disposed = false, finished = false, ready = false, timer = null, attempts = 0;
  const clear = () => { if (timer !== null) cancel(timer); timer = null; };
  const stop = () => { disposed = true; clear(); };
  const check = () => {
    if (disposed) return;
    clear();
    const current = inspectPluginPresentation(frame(), source, origin);
    onDocumentState(current.state);
    if (current.locale === locale) {
      finished = true;
      if (!ready) { ready = true; onReady(locale); }
      return;
    }
    // An eventual load/ready event may recover a slow document after the
    // bounded wait has shown an error; it must not restart polling forever.
    if (finished) return;
    // A fast cached child can announce before a passive React effect, while
    // a preference reply can be lost during document navigation. Reconcile
    // the current document, not a single message or an about:blank load event.
    try { publish(); } catch { /* Theme tokens may not exist until parent effects run. */ }
    if (++attempts >= maximumAttempts) { finished = true; onFailure(); return; }
    timer = schedule(check, 250);
  };
  check();
  return { stop, check };
}

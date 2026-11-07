// Trusted same-origin editor host. Only transports explicit parent UI actions
// to platform routes and loads the official plugin; no tool execution here.
const BASE = '/api/v1/design/editor/_integration/';
const PLUGIN = '96dfa740-005d-8020-8007-55ede24a2bae';
const CONNECT_HANDSHAKE_TIMEOUT_MS = 12000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export function mountPenpotEditorHost(host) {
  if (host.parent === host) return () => {};
  let binding, confirmed = 0, epoch = 0, timer, cancelHandshake, busy = false, disposed = false;
  let state = 'disconnected', reason = '', generation = 0;
  let observed = false, observation = 0, review = null, reviewObservation = 0, reviewTimer;
  const target = () => {
    const query = new URLSearchParams(host.location.hash.split('?')[1]);
    const fileId = query.get('file-id'), pageId = query.get('page-id');
    return UUID.test(fileId ?? '') && UUID.test(pageId ?? '') ? { fileId, pageId } : null;
  };
  const current = () => {
    const value = target();
    return binding && host.navigator.onLine !== false && Date.now() - confirmed < 6000
      && value?.fileId === binding.fileId && value?.pageId === binding.pageId ? binding : undefined;
  };
  const notify = (requestId) => host.parent.postMessage({ type: 'teamaibox.design.status/v1',
    ...(requestId ? { requestId } : {}), state, reason, generation, selectable: observed, target: target(),
    sessionID: current()?.sessionID ?? null, review }, host.location.origin);
  const post = async (action, body, keepalive = false) => {
    const cookies = host.document.cookie.split(';').map(v => v.trim()).filter(v => v.startsWith('__Host-teamaibox-csrf='));
    if (cookies.length !== 1) throw Error('session');
    const response = await host.fetch(BASE + action, { method: 'POST', credentials: 'same-origin', redirect: 'error',
      signal: AbortSignal.timeout(4000), keepalive,
      headers: { 'content-type': 'application/json', 'x-csrf-token': cookies[0].slice(cookies[0].indexOf('=') + 1) },
      body: JSON.stringify(body) });
    if (!response.ok) {
      if (action === 'select' && response.status === 409) {
        const failure=await response.json().catch(()=>null);
        if(failure?.error?.code==='penpot_agent_upgrade_required')throw Error('upgrade_required');
      }
      throw Error(response.status === 409 ? 'changed' : 'unavailable');
    }
    return response.json();
  };
  const disconnect = (why = 'disconnected', publish = true) => {
    const prior = binding; binding = undefined; confirmed = 0; epoch++; clearTimeout(timer);
    cancelHandshake?.();
    state = 'disconnected'; reason = why;
    try { host.ɵunloadPlugin?.(PLUGIN); } catch { /* no design mutations */ }
    if (prior) void post('disconnect', { connectionId: prior.connectionId, generation: prior.generation }, true).catch(() => {});
    if (publish && !disposed) notify();
  };
  const heartbeat = async (version) => {
    if (disposed || version !== epoch || !current()) { if (version === epoch) disconnect('reconnect'); return; }
    try {
      const expected = binding;
      const latest = await post('heartbeat', { connectionId: expected.connectionId, generation: expected.generation });
      if (version !== epoch) return;
      if (!current() || latest.connectionId !== expected.connectionId || latest.generation !== expected.generation) throw Error('changed');
      confirmed = Date.now(); timer = setTimeout(() => void heartbeat(version), 2000);
    } catch { if (version === epoch) disconnect('reconnect'); }
  };
  const connect = async (message) => {
    if (busy || review || !ID.test(message.sessionID ?? '') || !Number.isSafeInteger(message.expectedGeneration)
      || message.expectedGeneration < 0) return;
    const selected = target();
    if (!observed || !selected || typeof host.ɵloadPlugin !== 'function' || host.navigator.onLine === false) { reason = 'not_ready'; notify(message.requestId); return; }
    busy = true; disconnect(''); const version = epoch; state = 'connecting'; notify(message.requestId);
    try {
      const next = await post('select', { ...selected, sessionID: message.sessionID, expectedGeneration: message.expectedGeneration });
      generation = next.generation;
      if (disposed || version !== epoch || target()?.fileId !== selected.fileId || target()?.pageId !== selected.pageId) {
        void post('disconnect', { connectionId: next.connectionId, generation: next.generation }, true).catch(() => {}); return;
      }
      binding = next; confirmed = Date.now();
      const authority = Object.freeze({ current, authorize: async (id, task, params, ticket) => {
        const before = current(); if (!before || version !== epoch) throw Error('Design disconnected');
        const workspace = {};
        const route = new URLSearchParams(host.location.hash.split('?')[1]);
        if (UUID.test(route.get('project-id')??'')) workspace.projectId=route.get('project-id');
        const receipt = await post('claim', { request: { id, task, params }, ticket, workspace });
        void observeReview();
        if (version !== epoch || current() !== before) throw Error('Design target changed');
        return receipt;
      } });
      timer = setTimeout(() => void heartbeat(version), 2000);
      let onReady, handshakeTimer;
      const handshake = new Promise((resolve, reject) => {
        onReady=resolve;
        cancelHandshake=()=>reject(Error('superseded'));
        handshakeTimer=setTimeout(()=>reject(Error('handshake_timeout')),CONNECT_HANDSHAKE_TIMEOUT_MS);
      });
      const load=Promise.resolve().then(()=>host.ɵloadPlugin({ pluginId: PLUGIN, name: 'Penpot MCP Plugin',
        host: host.location.origin + BASE + 'plugin/index.html', code: 'plugin.js', version: 2,
        permissions: ['content:read', 'content:write', 'library:read', 'library:write', 'comment:read', 'comment:write'] },
      () => { if (version === epoch && binding) disconnect('plugin_closed'); },
      { teamaiboxDesign: authority, mcp: {
        getServerUrl: () => host.location.origin.replace(/^https:/, 'wss:') + '/api/v1/design/editor/ws/mcp/' + next.connectionId,
        getToken: () => undefined, on: () => {}, setMcpStatus: value => {
          if (version !== epoch) return;
          if (value === 'connected') { state = 'connected'; reason = ''; onReady(); notify(); }
          else if (state === 'connected') disconnect('reconnect');
        },
      } }));
      try {
        // Loading the plugin iframe isn't the same as establishing its socket.
        // A missing callback or hung loader must release the selected binding.
        await Promise.race([handshake, load.then(()=>handshake)]);
      } finally { clearTimeout(handshakeTimer); cancelHandshake=undefined; }
      if (version !== epoch) try { host.ɵunloadPlugin?.(PLUGIN); } catch { /* no design mutations */ }
    } catch (error) {
      if (version === epoch) disconnect(error.message==='handshake_timeout' ? 'reopen'
        : ['changed','upgrade_required'].includes(error.message) ? error.message : 'reconcile');
    } finally { busy = false; if (!disposed) notify(message.requestId); }
  };
  const observe = async requestId => {
    const version = ++observation;
    try {
      const [value] = await Promise.all([post('current', {}),observeReview()]);
      if(disposed || version !== observation)return;
      if(!Number.isSafeInteger(value.generation) || value.generation < 0)throw Error('unavailable');
      generation = Math.max(generation,value.generation); observed = true;
      if(state === 'disconnected' && reason === 'unavailable')reason = '';
    }catch{
      if(disposed || version !== observation)return;
      observed = false;
      if(binding)disconnect('reconnect');else reason = 'unavailable';
    }
    if(!disposed)notify(requestId);
  };
  const observeReview = async () => {
    const version=++reviewObservation;
    try {
      const {review: next}=await post('recovery',{});
      if(disposed||version!==reviewObservation)return;
      const previous=review;
      review=next??null;
      if(review?.state==='uncertain'&&binding)disconnect('reconcile');
      else if(JSON.stringify(previous)!==JSON.stringify(review))notify();
    }catch{ /* A failed observation must not clear an unresolved result. */ }
  };
  const reviewLoop = async () => {
    await observeReview();
    if(!disposed)reviewTimer=setTimeout(()=>void reviewLoop(),2000);
  };
  const receive = async event => {
    const m = event.data;
    if (disposed || event.origin !== host.location.origin || event.source !== host.parent
      || !m || m.type !== 'teamaibox.design.command/v1' || !ID.test(m.requestId ?? '')) return;
    if (m.action === 'connect') { await connect(m); return; }
    if (m.action === 'disconnect') { disconnect(); notify(m.requestId); return; }
    if(m.action==='open-review'&&review?.state==='uncertain'&&review.target){
      const original=review.target;
      const values=new URLSearchParams();
      for(const [key,value] of [['team-id',original.teamId],['project-id',original.projectId],
        ['file-id',original.fileId],['page-id',original.pageId]])if(UUID.test(value??''))values.set(key,value);
      if(values.has('file-id')&&values.has('page-id'))host.location.hash='#/workspace?'+values;
      return;
    }
    if(m.action==='reviewed'&&review?.state==='uncertain'&&review.target){
      const selected=target(), original=review.target;
      if(selected?.fileId!==original.fileId||selected?.pageId!==original.pageId)return;
      try{
        await post('reviewed',{reviewId:review.reviewId,fileId:original.fileId,pageId:original.pageId});
        await observeReview();reason='';notify(m.requestId);
      }catch{await observeReview();}
      return;
    }
    if (m.action === 'status') {
      // Existing server selection is informational, never an automatic attach.
      await observe(m.requestId);
    }
  };
  const changed = () => { if (binding || busy) disconnect('target_changed'); else notify(); };
  const offline = () => disconnect('offline');
  const pagehide = () => disconnect('reconnect', false);
  host.addEventListener('message', receive); host.addEventListener('hashchange', changed);
  host.addEventListener('offline', offline); host.addEventListener('pagehide', pagehide);
  notify();
  // Dynamic module loading may finish after the iframe's load event. Read the
  // generation here too, so the first click never depends on a manual refresh.
  void observe();
  reviewTimer=setTimeout(()=>void reviewLoop(),2000);
  return () => {
    disposed = true; clearTimeout(reviewTimer); disconnect('disconnected', false);
    host.removeEventListener('message', receive); host.removeEventListener('hashchange', changed);
    host.removeEventListener('offline', offline); host.removeEventListener('pagehide', pagehide);
  };
}

if (typeof window !== 'undefined') mountPenpotEditorHost(window);

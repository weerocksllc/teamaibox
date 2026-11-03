import { PlatformError } from '../../../../packages/observability/src/index.mjs';
import { nativeRequestTarget, forwardNativeResponse } from '../../../../services/agent-bridge/src/opencode-native-transport.mjs';

export const NATIVE_ASSISTANT_PREFIX = '/api/v1/assistant/native';
const denied = () => new PlatformError('access_denied', 'Assistant access is unavailable', {status:403});

// The platform authenticates the browser and chooses its container. OpenCode
// owns all session/extension state; no product execution record is created here.
export class NativeAssistantApi {
  #routes; #live = new Map(); #recheckMilliseconds;
  constructor({routes, recheckMilliseconds = 5000}) {
    if (typeof routes?.resolve !== 'function' || !Number.isSafeInteger(recheckMilliseconds) || recheckMilliseconds < 10) throw new TypeError('Native Assistant configuration is invalid');
    this.#routes = routes; this.#recheckMilliseconds = recheckMilliseconds;
  }
  matches(_method, pathname) { return pathname.startsWith(NATIVE_ASSISTANT_PREFIX + '/'); }
  async attachUpgrade({request,socket,head,context,authenticate}) {
    const owner=context?.identityId;
    if(!owner||!context.permissions?.includes('ai:invoke'))throw denied();
    const target=request.url.slice(NATIVE_ASSISTANT_PREFIX.length);
    const operation=nativeRequestTarget('GET',target).operation;
    if(!['pty.connect','v2.pty.connect'].includes(operation))throw denied();
    const controller=new AbortController();
    const live=this.#live.get(owner)??new Set();live.add(controller);this.#live.set(owner,live);
    let checking=false;
    const timer=setInterval(async()=>{
      if(checking||controller.signal.aborted)return;
      checking=true;
      try {const current=await authenticate();if(current.identityId!==owner||!current.permissions?.includes('ai:invoke'))controller.abort();}
      catch{controller.abort();}finally{checking=false;}
    },this.#recheckMilliseconds);
    timer.unref?.();
    const abort=()=>controller.abort();socket.once('close',abort);
    try{
      const route=await this.#routes.resolve(owner);
      const current=await authenticate();
      if(route.ownerIdentityId!==owner||!route.native||current.identityId!==owner||!current.permissions?.includes('ai:invoke'))throw denied();
      await route.native.upgrade(target,request,socket,head,{signal:controller.signal});
    }finally{
      clearInterval(timer);socket.off('close',abort);live.delete(controller);if(!live.size)this.#live.delete(owner);
    }
  }
  async handle({request, response, context, body, authenticate}) {
    const owner = context?.identityId;
    if (!owner || !context.permissions?.includes('ai:invoke')) throw denied();
    const target = request.url.slice(NATIVE_ASSISTANT_PREFIX.length);
    nativeRequestTarget(request.method, target);
    const controller = new AbortController();
    const abort = () => controller.abort();
    const live = this.#live.get(owner) ?? new Set();
    live.add(controller); this.#live.set(owner, live);
    request.once('aborted', abort); response.once('close', abort);
    let checking = false;
    const timer = setInterval(async () => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      try {
        const current = await authenticate();
        if (current.identityId !== owner || !current.permissions?.includes('ai:invoke')) abort();
      } catch { abort(); } finally { checking = false; }
    }, this.#recheckMilliseconds);
    timer.unref?.();
    try {
      const route = await this.#routes.resolve(owner);
      if (route.ownerIdentityId !== owner || !route.native) throw denied();
      const current = await authenticate();
      if (current.identityId !== owner || !current.permissions?.includes('ai:invoke')) throw denied();
      const upstream = await route.native.request(request.method, target, {
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal, accept: request.headers.accept ?? 'application/json',
      });
      await forwardNativeResponse(upstream, response);
    } finally {
      clearInterval(timer); request.off('aborted', abort); response.off('close', abort);
      live.delete(controller); if (!live.size) this.#live.delete(owner);
    }
  }
  handleSignOut({context}) { for (const controller of this.#live.get(context?.identityId) ?? []) controller.abort(); }
  close() { for (const live of this.#live.values()) for (const controller of live) controller.abort(); }
}

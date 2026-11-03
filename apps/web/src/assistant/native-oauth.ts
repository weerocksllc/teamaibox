import type {NativeClient} from './native-client';

export const nativeOAuthCallbackPath='/assistant/oauth/callback';
const channelName=(state:string)=>`teamaibox-native-oauth-${state}`;
const validState=(state:unknown):state is string=>typeof state==='string'&&/^[a-f0-9]{64}$/.test(state);

/** Native OpenCode owns discovery, PKCE, token exchange and credentials.
 * This short-lived browser channel only returns a same-origin authorization
 * response to the initiating client. Nothing is persisted or logged. */
export async function authorizeNativeMcp(client:NativeClient,name:string,directory:string) {
  if(client.signal.aborted)throw new DOMException('Authorization cancelled','AbortError');
  const popup=window.open('about:blank','_blank','popup,width=720,height=780');
  if(!popup)throw Error('oauth_popup_blocked');
  const lifetime=client.signal;
  let channel:BroadcastChannel|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let rejectPending:((reason:unknown)=>void)|undefined;
  const abort=()=>{popup.close();rejectPending?.(new DOMException('Authorization cancelled','AbortError'));};
  lifetime.addEventListener('abort',abort,{once:true});
  try {
    const settings=await client.request<{mcp?:Record<string,{type?:string;oauth?:false|Record<string,unknown>}>}>('/global/config');
    const entry=settings.mcp?.[name];
    if(entry?.type!=='remote'||entry.oauth===false)throw Error('oauth_not_available');
    const redirectUri=new URL(nativeOAuthCallbackPath,window.location.origin).href;
    await client.request('/global/config',{method:'PATCH',body:{mcp:{[name]:{...entry,oauth:{...entry.oauth,redirectUri}}}}});
    const started=await client.request<{authorizationUrl:string;oauthState:string}>(`/mcp/${encodeURIComponent(name)}/auth`,{method:'POST',directory});
    if(!started.authorizationUrl)return;
    if(!validState(started.oauthState))throw Error('oauth_invalid_state');
    const authorization=new URL(started.authorizationUrl);
    if(!['https:','http:'].includes(authorization.protocol)||authorization.username||authorization.password||authorization.searchParams.get('state')!==started.oauthState)throw Error('oauth_invalid_authorization_url');
    if(lifetime.aborted)throw new DOMException('Authorization cancelled','AbortError');
    channel=new BroadcastChannel(channelName(started.oauthState));
    const response=await new Promise<{code:string}>((resolve,reject)=>{
      rejectPending=reject;
      timer=setTimeout(()=>reject(Error('oauth_expired')),5*60*1000);
      channel!.onmessage=event=>{
        // BroadcastChannel is origin-scoped; native state binds this one flow.
        const value=event.data;
        if(value?.state!==started.oauthState)return;
        if(value.error){reject(Error('oauth_rejected'));return;}
        if(typeof value.code!=='string'||!value.code||value.code.length>16384){reject(Error('oauth_invalid_response'));return;}
        resolve({code:value.code});
      };
      popup.location.href=authorization.href;
    });
    channel.close();channel=undefined;
    if(lifetime.aborted)throw new DOMException('Authorization cancelled','AbortError');
    const result=await client.request<{status:string}>(`/mcp/${encodeURIComponent(name)}/auth/callback`,{method:'POST',directory,body:response});
    if(result.status!=='connected')throw Error('oauth_connection_failed');
  }finally{
    if(timer)clearTimeout(timer);channel?.close();popup.close();lifetime.removeEventListener('abort',abort);
  }
}

export function readNativeOAuthReturn(url:URL) {
  const state=url.searchParams.getAll('state'),code=url.searchParams.getAll('code'),error=url.searchParams.getAll('error');
  if(state.length!==1||!validState(state[0])||code.length>1||error.length>1)return null;
  if(error.length)return {state:state[0],error:true};
  if(code.length!==1||!code[0]||code[0].length>16384)return null;
  return {state:state[0],code:code[0]};
}
export function deliverNativeOAuthReturn(value:NonNullable<ReturnType<typeof readNativeOAuthReturn>>) {
  const channel=new BroadcastChannel(channelName(value.state));
  channel.postMessage(value);channel.close();
}

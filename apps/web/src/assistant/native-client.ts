const prefix = '/api/v1/assistant/native';
export type NativeSession = {id:string; title:string; parentID?:string; directory:string; revert?:{messageID:string;partID?:string};time:{created:number;updated:number;archived?:number}};
export type NativePart = {id:string;type:string;text?:string;url?:string;filename?:string;mime?:string;tool?:string;
  time?:{start:number;end?:number};
  state?:{status:string;input?:unknown;output?:string;error?:string;title?:string;metadata?:Record<string,unknown>;attachments?:NativePart[]};[key:string]:unknown};
export type NativeMessage = {info:{id:string;role:string;sessionID:string;agent?:string;modelID?:string;providerID?:string;
  cost?:number;summary?:boolean;tokens?:{input:number;output:number;reasoning?:number;cache?:{read:number;write:number}};error?:unknown;time:{created:number;completed?:number}};parts:NativePart[]};
export type NativePermission = {id:string;sessionID:string;permission:string;patterns:string[];metadata:Record<string,unknown>};
export type NativeQuestion = {id:string;sessionID:string;questions:{header:string;question:string;multiple?:boolean;custom?:boolean;options:{label:string;description:string}[]}[]};
export type NativeAgent = {name:string;description?:string;mode:string;hidden?:boolean};
export type NativeProviders = {providers:{id:string;name:string;models:Record<string,{id:string;name:string}>}[];default:Record<string,string>};
export type NativePty = {id:string;title:string;cwd:string;status:'running'|'exited';exitCode?:number};
export type NativeFile = {name:string;path:string;absolute:string;type:'file'|'directory';ignored:boolean};
export type NativeFileContent = {type:'text'|'binary';content:string;encoding?:'base64';mimeType?:string;diff?:string};

export class NativeApiError extends Error {
  status:number;
  code:string;
  constructor(status:number, code:string) { super(code); this.status=status; this.code=code; }
}
function csrf() {
  const value=document.cookie.split(';').map(v=>v.trim()).find(v=>v.startsWith('__Host-teamaibox-csrf='));
  if(!value)throw new NativeApiError(401,'csrf_unavailable');
  return value.slice(value.indexOf('=')+1);
}
export function createNativeClient() {
  let lifetime = new AbortController();
  return {
    get signal() { return lifetime.signal; },
    activate() { if(lifetime.signal.aborted)lifetime = new AbortController(); },
    close() { lifetime.abort(); },
    async readWorkspaceBytes(path:string,signal:AbortSignal):Promise<Uint8Array>{
      if(!path||path.startsWith('/')||/[\\%\r\n\0]/.test(path)||path.split('/').some(p=>!p||['.','..','.git','.teamaibox'].includes(p)))throw new TypeError('Invalid file path');
      const url=new URL(`${prefix}/api/fs/read/${path.split('/').map(encodeURIComponent).join('/')}`,window.location.origin);url.searchParams.set('directory','/workspace');
      const response=await fetch(url,{credentials:'same-origin',redirect:'error',signal:AbortSignal.any([signal,lifetime.signal]),headers:{accept:'application/octet-stream'}});
      if(!response.ok)throw new NativeApiError(response.status,`native_http_${response.status}`);
      const reader=response.body?.getReader();if(!reader)throw new NativeApiError(502,'media_body_missing');
      const chunks:Uint8Array[]=[];let length=0;
      try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>16*1024*1024)throw new NativeApiError(413,'media_too_large');chunks.push(value);}}
      finally{await reader.cancel();reader.releaseLock();}
      const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
    },
    async workspace<T>(operation:'folders'|'files',body:unknown):Promise<T>{
      const response=await fetch(`${prefix}/workspace/${operation}`,{method:'POST',credentials:'same-origin',redirect:'error',signal:lifetime.signal,
        headers:{accept:'application/json','content-type':'application/json','x-csrf-token':csrf()},body:JSON.stringify(body)});
      if(!response.ok)throw new NativeApiError(response.status,`native_http_${response.status}`);
      return response.json() as Promise<T>;
    },
    async readPatch(directory:string):Promise<string> {
      const url=new URL(`${prefix}/vcs/diff/raw`,window.location.origin);url.searchParams.set('directory',directory);
      const response=await fetch(url,{credentials:'same-origin',redirect:'error',signal:lifetime.signal,headers:{accept:'text/x-diff'}});
      if(!response.ok)throw new NativeApiError(response.status,`native_http_${response.status}`);
      return response.text();
    },
    async sessionPage(query:URLSearchParams,directory?:string):Promise<{items:NativeSession[];cursor:string|null}> {
      const url=new URL(`${prefix}/experimental/session`,window.location.origin);url.search=query.toString();
      // Omission requests all projects in the same authenticated user's engine.
      if(directory)url.searchParams.set('directory',directory);
      const response=await fetch(url,{credentials:'same-origin',redirect:'error',signal:lifetime.signal,headers:{accept:'application/json'}});
      if(!response.ok)throw new NativeApiError(response.status,`native_http_${response.status}`);
      return {items:await response.json(),cursor:response.headers.get('x-next-cursor')};
    },
    async readText(path:string,directory:string) {
      if(!path||path.startsWith('/')||/[\\\r\n\0]/.test(path)||path.split('/').some(part=>!part||part==='.'||part==='..'))throw new TypeError('Invalid file path');
      const url=new URL(`${prefix}/api/fs/read/${path.split('/').map(encodeURIComponent).join('/')}`,window.location.origin);
      url.searchParams.set('directory',directory);
      const response=await fetch(url,{credentials:'same-origin',redirect:'error',signal:lifetime.signal,headers:{accept:'application/octet-stream'}});
      if(!response.ok)throw new NativeApiError(response.status,`native_http_${response.status}`);
      // The legacy JSON preview trims whitespace. Editing must use native bytes.
      return new TextDecoder('utf-8',{fatal:true}).decode(await response.arrayBuffer());
    },
    terminal(id:string,ticket:string,directory:string,cursor?:number,api:'/pty'|'/api/pty'='/pty') {
      const signal=lifetime.signal;
      if(signal.aborted)throw new DOMException('Client closed','AbortError');
      const url=new URL(`${prefix}${api}/${encodeURIComponent(id)}/connect`,window.location.origin);
      url.protocol=url.protocol==='https:'?'wss:':'ws:';
      url.searchParams.set('ticket',ticket);url.searchParams.set('directory',directory);
      if(cursor!==undefined)url.searchParams.set('cursor',String(cursor));
      const socket=new WebSocket(url);socket.binaryType='arraybuffer';
      const close=()=>socket.close();signal.addEventListener('abort',close,{once:true});
      socket.addEventListener('close',()=>signal.removeEventListener('abort',close),{once:true});
      return socket;
    },
    async request<T>(path:string, {method='GET',body,directory='/workspace'}:{method?:string;body?:unknown;directory?:string}={}):Promise<T> {
      if(!path.startsWith('/')||path.startsWith('//'))throw new TypeError('Invalid native path');
      const url=new URL(prefix+path,window.location.origin);url.searchParams.set('directory',directory);
      const response=await fetch(url,{method,credentials:'same-origin',redirect:'error',signal:lifetime.signal,
        headers:{accept:'application/json',...(method==='GET'?{}:{'x-csrf-token':csrf()}),...(body===undefined?{}:{'content-type':'application/json'})},
        ...(body===undefined?{}:{body:JSON.stringify(body)})});
      if(!response.ok)throw new NativeApiError(response.status,`native_http_${response.status}`);
      if(response.status===204)return undefined as T;
      return response.json() as Promise<T>;
    },
    events(directory:string,onEvent:(event:{type:string;properties:Record<string,unknown>})=>void,onConnection:(connected:boolean)=>void) {
      const signal=lifetime.signal;
      const source=new EventSource(`${prefix}/event?directory=${encodeURIComponent(directory)}`,{withCredentials:true});
      const close=()=>source.close();
      if(signal.aborted){close();return close;}
      signal.addEventListener('abort',close,{once:true});
      source.onopen=()=>onConnection(true);source.onerror=()=>onConnection(false);
      source.onmessage=e=>{try{const value=JSON.parse(e.data);if(typeof value?.type==='string')onEvent(value);}catch{onConnection(false);}};
      return ()=>{close();signal.removeEventListener('abort',close);};
    },
  };
}
export type NativeClient = ReturnType<typeof createNativeClient>;

export function nativeFilePart(file:File):Promise<{type:'file';mime:string;filename:string;url:string}> {
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();reader.onerror=()=>reject(new Error('Attachment could not be read'));
    reader.onload=()=>resolve({type:'file',mime:file.type||'text/plain',filename:file.name,url:String(reader.result)});
    reader.readAsDataURL(file);
  });
}

import {useCallback,useEffect,useState} from 'react';
import {Button} from '@teamaibox/ui-system/components';
import type {Locale} from '../i18n';
import type {NativeClient} from './native-client';
import {nativeText} from './native-copy';
import {authorizeNativeMcp} from './native-oauth';

type McpConfig={type:'local';command:string[];enabled?:boolean;environment?:Record<string,string>}|{type:'remote';url:string;enabled?:boolean;headers?:Record<string,string>;oauth?:unknown};
type Status=Record<string,{status:string;error?:string}>;

/** Edits native configuration. Discovery, connections and execution stay in OpenCode. */
export function NativeExtensions({client,directory,locale,onError}:{client:NativeClient;directory:string;locale:Locale;onError:(error:unknown)=>void}) {
  const nt=(key:Parameters<typeof nativeText>[1])=>nativeText(locale,key);
  const [config,setConfig]=useState<Record<string,McpConfig>>({});
  const [status,setStatus]=useState<Status>({});
  const [name,setName]=useState('');const [kind,setKind]=useState<'local'|'remote'>('local');
  const [target,setTarget]=useState('');const [busy,setBusy]=useState(false);
  const authenticate=async(name:string)=>{setBusy(true);try{await authorizeNativeMcp(client,name,directory);await refresh();}catch(error){onError(error);}finally{setBusy(false);}};
  const disconnect=async(name:string)=>{setBusy(true);try{await client.request(`/mcp/${encodeURIComponent(name)}/auth`,{method:'DELETE',directory});await client.request(`/mcp/${encodeURIComponent(name)}/disconnect`,{method:'POST',directory});await refresh();}catch(error){onError(error);}finally{setBusy(false);}};
  const refresh=useCallback(async()=>{
    const [settings,state]=await Promise.all([client.request<{mcp?:Record<string,McpConfig>}>('/global/config'),client.request<Status>('/mcp',{directory})]);
    if(!client.signal.aborted){setConfig(settings.mcp??{});setStatus(state);}
  },[client,directory]);
  useEffect(()=>{void refresh().catch(onError);},[refresh,onError]);
  const save=async(name:string,value:McpConfig)=>{
    setBusy(true);
    try{
      // Patch only this MCP entry; leave unrelated native user settings intact.
      await client.request('/global/config',{method:'PATCH',body:{mcp:{[name]:value}}});
      await refresh();return true;
    }catch(error){onError(error);return false;}finally{setBusy(false);}
  };
  const add=async()=>{
    if(!/^[A-Za-z0-9_-]+$/.test(name))return;
    try{
      let value:McpConfig;
      if(kind==='local'){
        const command:unknown=JSON.parse(target);
        if(!Array.isArray(command)||!command.length||!command.every(v=>typeof v==='string'&&v.length>0))throw Error('MCP command must be a non-empty JSON string array');
        value={type:'local',command,enabled:true};
      }else{
        const url=new URL(target);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('MCP URL must use HTTP(S) without embedded credentials');
        value={type:'remote',url:url.href,enabled:true};
      }
      if(await save(name,value)){setName('');setTarget('');}
    }catch(error){onError(error);}
  };
  return <section className="native-extensions">
    <h3>MCP</h3>
    <ul>{Object.entries(config).map(([key,value])=><li key={key}><strong>{key}</strong> · {status[key]?.status??'—'}
      <label><input type="checkbox" checked={value.enabled!==false} disabled={busy} aria-label={key} onChange={event=>void save(key,{...value,enabled:event.target.checked})}/> MCP</label>
      {value.type==='remote'&&value.oauth!==false&&<div className="native-actions"><Button variant="secondary" disabled={busy||value.enabled===false} onClick={()=>void authenticate(key)}>{nt('authenticate')}</Button><Button variant="quiet" disabled={busy} onClick={()=>void disconnect(key)}>{nt('disconnect')}</Button></div>}
      {status[key]?.error&&<p role="status">{status[key].error}</p>}
    </li>)}</ul>
    <form onSubmit={event=>{event.preventDefault();void add();}}>
      <label>MCP<input value={name} pattern="[A-Za-z0-9_-]+" required onChange={event=>setName(event.target.value)} disabled={busy}/></label>
      <select value={kind} onChange={event=>{setKind(event.target.value as typeof kind);setTarget('');}} aria-label="MCP transport" disabled={busy}><option value="local">stdio</option><option value="remote">HTTP</option></select>
      <label>{kind==='local'?`${nt('command')} (JSON)`:'URL'}<input value={target} required onChange={event=>setTarget(event.target.value)} spellCheck={false} disabled={busy} placeholder={kind==='local'?'["node", "/workspace/mcp/server.mjs"]':'https://example.org/mcp'}/></label>
      <Button type="submit" variant="primary" disabled={busy||Boolean(config[name])}>{nt('save')}</Button>
    </form>
  </section>;
}

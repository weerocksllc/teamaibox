import {useEffect,useRef,useState} from 'react';
import {Button} from '@teamaibox/ui-system/components';
import type {Locale} from '../i18n';
import {NativeApiError,type NativeClient,type NativeMessage,type NativeSession,type NativePty} from './native-client';
import {NativeTerminal} from './NativeTerminal';
import {nativeResultPath} from './native-workspace-path';
import {nativeTransferText} from './native-transfer-copy';

/** Export native records verbatim; import is the bundled native CLI, never a second database implementation. */
export function NativeSessionTransfer({client,directory,sessionId,running,locale,onError,onImported}:{client:NativeClient;directory:string;sessionId:string|null;running:boolean;locale:Locale;onError:(error:unknown)=>void;onImported:(session:NativeSession)=>void}){
  const [path,setPath]=useState(''),[confirm,setConfirm]=useState(false),[busy,setBusy]=useState(false);
  const [job,setJob]=useState<{pty:NativePty;sessionID:string}|null>(null),[result,setResult]=useState<NativeSession|null>(null);
  const [exit,setExit]=useState<number|null>(null);const alive=useRef(true);
  const nt=(key:Parameters<typeof nativeTransferText>[1])=>nativeTransferText(locale,key);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(!job)return;let stopped=false,timer:ReturnType<typeof setTimeout>|undefined;
    const check=async()=>{
      try{
        const {data:pty}=await client.request<{data:NativePty}>(`/api/pty/${encodeURIComponent(job.pty.id)}`,{directory});
        if(stopped)return;
        if(pty.status==='running'){timer=setTimeout(()=>void check(),1000);return;}
        setBusy(false);setExit(pty.exitCode??-1);
        if(pty.exitCode===0){const session=await client.request<NativeSession>(`/session/${encodeURIComponent(job.sessionID)}`,{directory});if(!stopped)setResult(session);}
      }catch(error){if(!stopped){setBusy(false);onError(error);}}
    };
    void check();return()=>{stopped=true;clearTimeout(timer);};
  },[client,directory,job,onError]);
  const download=async()=>{
    if(!sessionId||running||busy)return;setBusy(true);
    try{
      const id=encodeURIComponent(sessionId);
      const [info,messages]=await Promise.all([client.request<NativeSession>(`/session/${id}`,{directory}),client.request<NativeMessage[]>(`/session/${id}/message`,{directory})]);
      if(!alive.current||client.signal.aborted)return;
      const url=URL.createObjectURL(new Blob([JSON.stringify({info,messages},null,2)+'\n'],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download=`${sessionId}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(error){if(alive.current)onError(error);}finally{if(alive.current)setBusy(false);}
  };
  const startImport=async()=>{
    if(busy||job)return;setBusy(true);
    try{
      const relative=nativeResultPath(path,directory);if(!relative)throw Error('Invalid workspace file path');
      const data=JSON.parse(await client.readText(relative,directory));
      if(!/^ses_[A-Za-z0-9]+$/.test(data?.info?.id)||!Array.isArray(data?.messages))throw Error('Invalid OpenCode conversation file');
      try{await client.request(`/session/${encodeURIComponent(data.info.id)}`,{directory});throw Error(nt('existing'));}
      catch(error){if(!(error instanceof NativeApiError&&error.status===404))throw error;}
      // Direct argv avoids shell interpolation; OpenCode validates and imports its own format.
      const {data:pty}=await client.request<{data:NativePty}>('/api/pty',{method:'POST',directory,body:{command:'/opt/opencode/opencode',args:['import',directory+'/'+relative],cwd:directory,title:nt('import')}});
      if(alive.current)setJob({pty,sessionID:data.info.id});
    }catch(error){if(alive.current){setBusy(false);onError(error);}}
  };
  return <section className="native-session-transfer native-customization">
    <p>{nt('privacy')}</p><Button variant="secondary" disabled={!sessionId||running||busy} onClick={()=>void download()}>{nt('export')}</Button>
    <form onSubmit={event=>{event.preventDefault();setConfirm(true);}}><label>{nt('file')}<input dir="ltr" value={path} required disabled={busy||Boolean(job)} onChange={event=>{setPath(event.target.value);setConfirm(false);}} placeholder="conversation.json"/></label>
      {!confirm&&<Button type="submit" variant="secondary" disabled={busy||Boolean(job)||!path}>{nt('import')}</Button>}
    </form>
    {confirm&&!job&&<><p>{nt('importConfirm')}</p><Button variant="primary" disabled={busy} onClick={()=>void startImport()}>{nt('import')}</Button></>}
    {job&&<><NativeTerminal client={client} id={job.pty.id} directory={directory} locale={locale} onError={onError} api="/api/pty"/>{exit!==null&&<output>OpenCode · {exit===0?'✓':`exit ${exit}`}</output>}</>}
    {result&&<Button variant="primary" onClick={()=>onImported(result)}>{result.title}</Button>}
  </section>;
}

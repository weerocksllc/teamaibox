import {useState} from 'react';
import {Button} from '@teamaibox/ui-system/components';
import type {Locale} from '../i18n';
import type {NativeClient,NativeAgent,NativeMessage} from './native-client';
import {nativeShellText} from './native-shell-copy';
import {nativeText} from './native-copy';
import {nativeModelChoice} from './native-model';
import {nativeShellAgent} from './native-shell-agent';

export function NativeSessionShell({client,directory,sessionId,locale,agent,model,running,onError,onResult}:{client:NativeClient;directory:string;sessionId:string;locale:Locale;agent:string;model:string;running:boolean;onError:(error:unknown)=>void;onResult:()=>void}){
  const [command,setCommand]=useState('');const [busy,setBusy]=useState(false);const [uncertain,setUncertain]=useState(false);
  const [result,setResult]=useState<NativeMessage|null>(null);
  const st=(key:Parameters<typeof nativeShellText>[1])=>nativeShellText(locale,key);
  const run=async()=>{
    if(busy||running||uncertain||!command.trim())return;setBusy(true);setResult(null);
    let dispatched=false;
    try{
      const [config,agents]=await Promise.all([client.request<{model?:string;default_agent?:string}>('/config',{directory}),client.request<NativeAgent[]>('/agent',{directory})]);
      const chosen=nativeShellAgent(agent,config.default_agent,agents);
      const selectedModel=nativeModelChoice(model,config.model);
      dispatched=true;
      const response=await client.request<NativeMessage>(`/session/${encodeURIComponent(sessionId)}/shell`,{method:'POST',directory,body:{command,agent:chosen,model:selectedModel}});
      if(client.signal.aborted)return;setResult(response);onResult();
    }catch(error){if(!client.signal.aborted){setUncertain(dispatched);onError(error instanceof Error&&error.message==='native_shell_select_agent'?new Error(st('selectAgent')):error);}}
    finally{if(!client.signal.aborted)setBusy(false);}
  };
  return <section className="native-session-shell"><p>{st('notice')}</p><code dir="ltr">{directory}</code>
    <form onSubmit={event=>{event.preventDefault();void run();}}><textarea dir="ltr" className="native-config-editor" aria-label={st('title')} spellCheck={false} rows={5} value={command} disabled={busy} onChange={event=>setCommand(event.target.value)}/>
      <Button type="submit" variant="primary" disabled={busy||running||uncertain||!command.trim()}>{st('run')}</Button>
    </form>
    {uncertain&&<p role="status">{nativeText(locale,'uncertain')}</p>}
    {result&&<pre className="native-detail" dir="ltr" tabIndex={0}>{result.parts.filter(part=>part.type==='tool').map(part=>part.state?.output??part.state?.error??JSON.stringify(part.state,null,2)).join('\n')}</pre>}
  </section>;
}

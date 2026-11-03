import {useState} from 'react';
import {Button} from '@teamaibox/ui-system/components';
import type {Locale} from '../i18n';
import type {NativeClient,NativeMessage,NativePart} from './native-client';
import {nativeHistoryEditText} from './native-history-edit-copy';
import {nativeText} from './native-copy';

/** Native history mutations only. Editing never replays a prompt or undoes tools. */
export function NativeMessageEditor({client,directory,message,running,locale,onError,onSaved}:{client:NativeClient;directory:string;message:NativeMessage;running:boolean;locale:Locale;onError:(error:unknown)=>void;onSaved:()=>void}){
  const ht=(key:Parameters<typeof nativeHistoryEditText>[1])=>nativeHistoryEditText(locale,key);
  const [open,setOpen]=useState(false);const [part,setPart]=useState<NativePart|null>(null);const [draft,setDraft]=useState('');
  const [confirmation,setConfirmation]=useState<'message'|'part'|null>(null);const [baseline,setBaseline]=useState('');const [busy,setBusy]=useState(false);
  const choose=(id:string)=>{const value=message.parts.find(item=>item.id===id)??null;setPart(value);setDraft(value?.text??'');setConfirmation(null);};
  const mutate=async(action:'save'|'part'|'message')=>{
    if(busy||running||(!part&&action!=='message'))return;setBusy(true);
    const root=`/session/${encodeURIComponent(message.info.sessionID)}/message/${encodeURIComponent(message.info.id)}`;
    try{
      const [states,current]=await Promise.all([client.request<Record<string,{type:string}>>('/session/status',{directory}),client.request<NativeMessage>(root,{directory})]);
      if(states[message.info.sessionID]&&states[message.info.sessionID].type!=='idle')throw Error(ht('conflict'));
      const actual=current.parts.find(item=>item.id===part?.id);
      if(action==='message'?JSON.stringify(current)!==baseline:JSON.stringify(actual)!==JSON.stringify(part))throw Error(ht('conflict'));
      if(action==='message')await client.request(root,{method:'DELETE',directory});
      else await client.request(`${root}/part/${encodeURIComponent(part!.id)}`,{method:action==='part'?'DELETE':'PATCH',directory,...(action==='save'?{body:{...part,text:draft}}:{})});
      if(!client.signal.aborted){setOpen(false);setConfirmation(null);setPart(null);onSaved();}
    }catch(error){if(!client.signal.aborted)onError(error);}finally{if(!client.signal.aborted)setBusy(false);}
  };
  return <section className="native-message-editor" data-native-message={message.info.id}>
    <Button variant="quiet" disabled={busy||running} onClick={()=>{setOpen(value=>!value);choose(message.parts[0]?.id??'');setBaseline(JSON.stringify(message));}}>{ht('manage')}</Button>
    {open&&<div role="group" aria-label={ht('manage')}><p>{ht('warning')}</p>
      <select aria-label={ht('part')} disabled={busy||running} value={part?.id??''} onChange={event=>choose(event.target.value)}>{message.parts.map((item,index)=><option key={item.id} value={item.id}>{index+1} · {item.type}</option>)}</select>
      {part?.type==='text'?<textarea className="native-config-editor" aria-label={ht('edit')} value={draft} disabled={busy||running} onChange={event=>setDraft(event.target.value)} rows={4}/>:part&&<pre className="native-detail" dir="ltr">{JSON.stringify(part,null,2)}</pre>}
      <div className="native-actions">{part?.type==='text'&&<Button variant="secondary" disabled={busy||running||draft===part.text} onClick={()=>void mutate('save')}>{nativeText(locale,'save')}</Button>}
        <Button variant="quiet" disabled={busy||running||!part} onClick={()=>setConfirmation('part')}>{ht('deletePart')}</Button>
        <Button variant="quiet" disabled={busy||running} onClick={()=>setConfirmation('message')}>{ht('deleteMessage')}</Button>
        <Button variant="quiet" disabled={busy} onClick={()=>{setOpen(false);setPart(null);setConfirmation(null);}}>{ht('cancel')}</Button>
      </div>
      {confirmation&&<div role="group" aria-label={ht(confirmation==='message'?'deleteMessage':'deletePart')}><p>{ht('warning')}</p><Button variant="primary" disabled={busy||running} onClick={()=>void mutate(confirmation)}>{ht('confirm')}</Button><Button variant="quiet" disabled={busy} onClick={()=>setConfirmation(null)}>{ht('cancel')}</Button></div>}
    </div>}
  </section>;
}

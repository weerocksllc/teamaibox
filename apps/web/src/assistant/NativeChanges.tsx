import {useEffect,useState} from 'react';
import type {Locale} from '../i18n';
import type {NativeClient,NativeMessage} from './native-client';
import {nativeText} from './native-copy';

export function NativeChanges({client,sessionId,directory,messages,locale,onError}:{client:NativeClient;sessionId:string;directory:string;messages:NativeMessage[];locale:Locale;onError:(error:unknown)=>void}) {
  const turns=messages.filter(message=>message.info.role==='user');
  const [messageId,setMessageId]=useState(()=>turns.at(-1)?.info.id??'');
  const [diff,setDiff]=useState<unknown>(null);
  useEffect(()=>{
    let stale=false;setDiff(null);
    if(messageId)void client.request(`/session/${encodeURIComponent(sessionId)}/diff?messageID=${encodeURIComponent(messageId)}`,{directory})
      .then(value=>{if(!stale)setDiff(value);}).catch(error=>{if(!stale)onError(error);});
    else setDiff([]);
    return()=>{stale=true;};
  },[client,sessionId,directory,messageId,onError]);
  return <section className="native-changes"><select aria-label={nativeText(locale,'changes')} value={messageId} onChange={event=>setMessageId(event.target.value)}>
    {turns.map((message,index)=><option key={message.info.id} value={message.info.id}>{index+1}. {message.parts.find(part=>part.type==='text')?.text?.slice(0,100)||message.info.id}</option>)}
  </select><pre className="native-detail">{diff===null?'…':JSON.stringify(diff,null,2)}</pre></section>;
}

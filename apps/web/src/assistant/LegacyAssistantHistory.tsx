import {useEffect,useState} from 'react';
import {Button} from '@teamaibox/ui-system/components';
import {getAssistantConversation,listAssistantConversations,type AssistantConversation,type AssistantConversationSummary} from './assistant-client';
import {nativeText} from './native-copy';
import type {Locale} from '../i18n';
import {createI18nRuntime} from '../i18n';

/** Historical product records are never imported as prompts or replayed.
 * Existing native records are listed separately by OpenCode and can be resumed. */
export function LegacyAssistantHistory({locale,onError,onResume}:{locale:Locale;onError:(error:unknown)=>void;onResume:(session:{id:string;directory:string})=>void}) {
  const t=createI18nRuntime({locale}).translate;
  const [items,setItems]=useState<AssistantConversationSummary[]>([]);
  const [id,setId]=useState<string|null>(null);
  const [detail,setDetail]=useState<AssistantConversation|null>(null);
  useEffect(()=>{
    const controller=new AbortController();
    void listAssistantConversations(controller.signal).then(value=>{if(!controller.signal.aborted)setItems(value);}).catch(error=>{if(!controller.signal.aborted)onError(error);});
    return()=>controller.abort();
  },[onError]);
  useEffect(()=>{
    const controller=new AbortController();setDetail(null);
    if(id)void getAssistantConversation(id,controller.signal).then(value=>{if(!controller.signal.aborted)setDetail(value);}).catch(error=>{if(!controller.signal.aborted)onError(error);});
    return()=>controller.abort();
  },[id,onError]);
  return <section className="native-legacy-history">{!detail?.nativeSession&&<p>{nativeText(locale,'legacyReadOnly')}</p>}
    <nav className="native-actions">{items.map(item=><Button key={item.id} variant={id===item.id?'primary':'secondary'} onClick={()=>setId(item.id)}>{item.title||new Intl.DateTimeFormat(locale,{dateStyle:'short'}).format(new Date(item.createdAt))}</Button>)}</nav>
    {detail?.nativeSession&&<Button variant="primary" onClick={()=>onResume(detail.nativeSession!)}>{nativeText(locale,'resumeOriginal')}</Button>}
    {detail?.messages.map(message=><article key={message.id}><h3>{t(message.role==='user'?'assistant.workspace.you':'assistant.workspace.assistant')}</h3><p className="native-history-text">{message.content}</p>
      {!!message.toolCalls.length&&<details><summary>{nativeText(locale,'tasks')}</summary><pre>{JSON.stringify(message.toolCalls,null,2)}</pre></details>}
      {message.artifacts.map(file=>file.downloadPath?.startsWith('/api/')?<a key={file.referenceId} href={file.downloadPath} download>{file.label}</a>:<span key={file.referenceId}>{file.label}</span>)}
    </article>)}
  </section>;
}

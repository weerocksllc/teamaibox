import {useEffect,useRef,useState} from 'react';
import {Button} from '@teamaibox/ui-system/components';
import type {Locale} from '../i18n';
import type {NativeClient,NativeSession} from './native-client';
import {nativeSessionText} from './native-session-copy';
import {isNativeWorkspace} from './native-workspace-path';

/** Owner-wide native search; no parallel session index or history store. */
export function NativeSessionIndex({client,directory,locale,onOpen,onError}:{client:NativeClient;directory:string;locale:Locale;onOpen:(item:NativeSession)=>void;onError:(error:unknown)=>void}){
  const st=(key:Parameters<typeof nativeSessionText>[1])=>nativeSessionText(locale,key);
  const [draft,setDraft]=useState('');const [search,setSearch]=useState('');const [current,setCurrent]=useState(false);const [archived,setArchived]=useState(false);
  const [items,setItems]=useState<NativeSession[]>([]);const [cursor,setCursor]=useState<string|null>(null);const [busy,setBusy]=useState(false);const [ready,setReady]=useState(false);
  const generation=useRef(0);
  const load=async(next:string|null,revision:number)=>{
    setBusy(true);
    try{
      const query=new URLSearchParams({limit:'50',archived:String(archived)});if(search)query.set('search',search);if(next)query.set('cursor',next);
      const page=await client.sessionPage(query,current?directory:undefined);
      if(revision!==generation.current||client.signal.aborted)return;
      setItems(previous=>next?[...previous,...page.items.filter(item=>!previous.some(prior=>prior.id===item.id))]:page.items);setCursor(page.cursor===next?null:page.cursor);setReady(true);
    }catch(error){if(revision===generation.current&&!client.signal.aborted)onError(error);}finally{if(revision===generation.current&&!client.signal.aborted)setBusy(false);}
  };
  useEffect(()=>{const revision=++generation.current;setItems([]);setCursor(null);setReady(false);void load(null,revision);return()=>{++generation.current;};},[client,directory,search,current,archived]);
  return <section className="native-session-index native-customization">
    <form onSubmit={event=>{event.preventDefault();setSearch(draft.trim());}}><label>{st('search')}<input value={draft} onChange={event=>setDraft(event.target.value)}/></label><Button type="submit" variant="secondary" disabled={busy}>{st('browse')}</Button></form>
    <label><input type="checkbox" checked={current} onChange={event=>setCurrent(event.target.checked)}/>{st('current')}</label><label><input type="checkbox" checked={archived} onChange={event=>setArchived(event.target.checked)}/>{st('archived')}</label>
    <p>{current?directory:st('all')}</p><ul>{items.map(item=><li key={item.id}><Button variant="quiet" disabled={!isNativeWorkspace(item.directory)} onClick={()=>onOpen(item)}>{item.title}</Button><code dir="ltr">{item.directory}</code><time>{new Intl.DateTimeFormat(locale,{dateStyle:'short'}).format(item.time.updated)}</time></li>)}</ul>
    {busy?<p>…</p>:ready&&!items.length?<p>{st('empty')}</p>:null}
    {cursor&&<Button variant="secondary" disabled={busy} onClick={()=>void load(cursor,generation.current)}>{st('more')}</Button>}
  </section>;
}

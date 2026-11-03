import {useCallback,useEffect,useState} from 'react';
import {Button} from '@teamaibox/ui-system/components';
import type {Locale} from '../i18n';
import type {NativeClient} from './native-client';
import {nativeText} from './native-copy';
import {nativeWorktreeText} from './native-worktree-copy';
import {isNativeWorkspace} from './native-workspace-path';

type Worktree={name:string;directory:string};
export function NativeWorktrees({client,directory,primary,locale,onOpen,onError}:{client:NativeClient;directory:string;primary:string;locale:Locale;onOpen:(path:string)=>void;onError:(error:unknown)=>void}){
  const [items,setItems]=useState<Worktree[]>([]),[name,setName]=useState(''),[typed,setTyped]=useState('');
  const [busy,setBusy]=useState(false),[confirmation,setConfirmation]=useState<{action:'create'|'reset'|'remove';item?:Worktree}|null>(null);
  const wt=(key:Parameters<typeof nativeWorktreeText>[1])=>nativeWorktreeText(locale,key);
  const list=useCallback(async()=>{
    const paths=await client.request<string[]>('/experimental/worktree',{directory});
    return paths.filter(isNativeWorkspace).map(path=>({directory:path,name:path.split('/').at(-1)!}));
  },[client,directory]);
  useEffect(()=>{let stale=false;void list().then(value=>{if(!stale)setItems(value);}).catch(onError);return()=>{stale=true;};},[list,onError]);
  const run=async()=>{
    if(!confirmation||busy)return;setBusy(true);
    try{
      const {action,item}=confirmation;
      if(action==='create')await client.request('/experimental/worktree',{directory,method:'POST',body:{name:name.trim()}});
      else{
        // Do not submit a stale or manually supplied directory to native destructive operations.
        const current=await list();
        if(!item||typed!==item.name||item.directory===primary||!isNativeWorkspace(item.directory)||!current.some(value=>value.directory===item.directory&&value.name===item.name))throw Error('Worktree selection changed');
        await client.request(action==='reset'?'/experimental/worktree/reset':'/experimental/worktree',{directory,method:action==='reset'?'POST':'DELETE',body:{directory:item.directory}});
      }
      if(client.signal.aborted)return;
      setItems(await list());setConfirmation(null);setTyped('');if(action==='create')setName('');
    }catch(error){if(!client.signal.aborted)onError(error);}finally{setBusy(false);}
  };
  return <section className="native-worktrees"><h3>{wt('worktrees')}</h3>
    <form onSubmit={event=>{event.preventDefault();setConfirmation({action:'create'});}}>
      <label>{wt('name')}<input value={name} onChange={event=>{setName(event.target.value);setConfirmation(null);}} disabled={busy} required/></label>
      <Button variant="secondary" type="submit" disabled={busy||!name.trim()}>{wt('create')}</Button>
    </form>
    <ul className="native-file-list">{items.filter(item=>isNativeWorkspace(item.directory)&&item.directory!==primary).map(item=><li key={item.directory} data-worktree={item.name}>
      <span>{item.name}</span><code dir="ltr">{item.directory}</code>
      <Button variant="secondary" disabled={busy} onClick={()=>onOpen(item.directory)}>{nativeText(locale,'project')}</Button>
      {(['reset','remove'] as const).map(action=><Button key={action} variant="quiet" disabled={busy||item.directory===directory} onClick={()=>{setConfirmation({action,item});setTyped('');}}>{wt(action)}</Button>)}
    </li>)}</ul>
    {confirmation&&<div className="assistant-confirmation" role="group" aria-label={wt(confirmation.action)}>
      <p>{wt(confirmation.action==='create'?'createWarning':confirmation.action==='reset'?'resetWarning':'removeWarning')}</p>
      {confirmation.item&&<><code dir="ltr">{confirmation.item.directory}</code><label>{wt('confirmName')}<input value={typed} disabled={busy} onChange={event=>setTyped(event.target.value)}/></label></>}
      <Button variant="primary" disabled={busy||(confirmation.item!==undefined&&typed!==confirmation.item.name)} onClick={()=>void run()}>{wt(confirmation.action)}</Button>
      <Button variant="quiet" disabled={busy} onClick={()=>setConfirmation(null)}>{wt('cancel')}</Button>
    </div>}
  </section>;
}

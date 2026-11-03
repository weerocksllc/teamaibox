import {useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '@teamaibox/ui-system/components';
import type {Locale} from '../i18n';
import type {NativeClient} from './native-client';
import {nativeText} from './native-copy';
import {nativeProjectText} from './native-project-copy';
import {isNativeWorkspace} from './native-workspace-path';
import {NativeWorktrees} from './NativeWorktrees';

type Project={id:string;name?:string;worktree:string;vcs?:string;sandboxes:string[]};
export function NativeProjects({client,directory,locale,onOpen,onError}:{client:NativeClient;directory:string;locale:Locale;onOpen:(directory:string)=>void;onError:(error:unknown)=>void}){
  const [projects,setProjects]=useState<Project[]>([]),[current,setCurrent]=useState<Project|null>(null);
  const [name,setName]=useState(''),[busy,setBusy]=useState(false),[confirm,setConfirm]=useState(false);
  const [directories,setDirectories]=useState<Record<string,string[]>>({});
  const live=useRef(true);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  const nt=(key:Parameters<typeof nativeText>[1])=>nativeText(locale,key);
  const pt=(key:Parameters<typeof nativeProjectText>[1])=>nativeProjectText(locale,key);
  const load=useCallback(async()=>{
    const [list,active]=await Promise.all([client.request<Project[]>('/project',{directory}),client.request<Project>('/project/current',{directory})]);
    if(live.current){setProjects(list);setCurrent(active);setName(active.name??'');}
  },[client,directory]);
  useEffect(()=>{void load().catch(onError);},[load,onError]);
  const action=async(path:string,method:string,body?:unknown)=>{
    if(busy)return;setBusy(true);
    try{await client.request(path,{method,body,directory});await load();if(live.current)setConfirm(false);}catch(error){if(live.current)onError(error);}finally{if(live.current)setBusy(false);}
  };
  const showDirectories=async(project:Project)=>{
    try{const entries=await client.request<{directory:string}[]>(`/project/${encodeURIComponent(project.id)}/directories`,{directory});
      const paths=[...new Set([project.worktree,...project.sandboxes,...entries.map(item=>item.directory)])].filter(isNativeWorkspace);
      if(live.current)setDirectories(value=>({...value,[project.id]:paths}));
    }catch(error){if(live.current)onError(error);}
  };
  return <section className="native-project-manager native-customization">
    <code dir="ltr">{directory}</code>
    {current&&<form onSubmit={event=>{event.preventDefault();void action(`/project/${encodeURIComponent(current.id)}`,'PATCH',{name:name.trim()});}}>
      <label>{pt('projectName')}<input value={name} required disabled={busy} onChange={event=>setName(event.target.value)}/></label>
      <Button type="submit" variant="primary" disabled={busy||!name.trim()}>{nt('save')}</Button>
    </form>}
    {current?.vcs!=='git'&&current&&<div>
      {confirm?<><p>{pt('initializeConfirm')}</p><Button variant="primary" disabled={busy} onClick={()=>void action('/project/git/init','POST')}>{pt('initializeGit')}</Button><Button variant="quiet" disabled={busy} onClick={()=>setConfirm(false)}>{nt('back')}</Button></>:
        <Button variant="secondary" disabled={busy} onClick={()=>setConfirm(true)}>{pt('initializeGit')}</Button>}
    </div>}
    {current?.vcs==='git'&&<NativeWorktrees key={directory} client={client} directory={directory} primary={current.worktree} locale={locale} onOpen={onOpen} onError={onError}/>}
    <ul className="native-file-list">{projects.map(project=><li key={project.id}>
      <Button variant="quiet" onClick={()=>void showDirectories(project)}>{project.name||project.worktree}</Button>
      {directories[project.id]?.map(path=><Button key={path} variant="secondary" disabled={busy} onClick={()=>onOpen(path)}><span dir="ltr">{path}</span></Button>)}
    </li>)}</ul>
  </section>;
}

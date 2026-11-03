import {useEffect,useState} from 'react';
import {Button} from '@teamaibox/ui-system/components';
import type {Locale} from '../i18n';
import type {NativeClient} from './native-client';
import {nativeGitText} from './native-git-copy';
import {nativeSessionText} from './native-session-copy';

type Status={file:string;additions:number;deletions:number;status:string};
type Diff={file:string;patch?:string;additions:number;deletions:number;status?:string};
type Snapshot={git:boolean;branch?:string;default_branch?:string;status:Status[];diff:Diff[]};

/** Read-only native working-tree/branch diffs. Never computes patches or resets Git. */
export function NativeGitChanges({client,directory,locale,onError}:{client:NativeClient;directory:string;locale:Locale;onError:(error:unknown)=>void}){
  const gt=(key:Parameters<typeof nativeGitText>[1])=>nativeGitText(locale,key);
  const [open,setOpen]=useState(false);const [mode,setMode]=useState<'git'|'branch'>('git');
  const [revision,setRevision]=useState(0);const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
  const [busy,setBusy]=useState(false);const [failed,setFailed]=useState(false);
  const download=async()=>{setBusy(true);try{const patch=await client.readPatch(directory);if(client.signal.aborted)return;const url=URL.createObjectURL(new Blob([patch],{type:'text/x-diff;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='workspace.patch';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){onError(error);}finally{if(!client.signal.aborted)setBusy(false);}};
  useEffect(()=>{
    if(!open)return;let stale=false;setSnapshot(null);setBusy(true);setFailed(false);
    const load=async()=>{
      const project=await client.request<{vcs?:string}>('/project/current',{directory});
      if(project.vcs!=='git')return {git:false,status:[],diff:[]};
      const [info,status]=await Promise.all([client.request<{branch?:string;default_branch?:string}>('/vcs',{directory}),client.request<Status[]>('/vcs/status',{directory})]);
      const diff=mode==='branch'&&!info.default_branch?[]:await client.request<Diff[]>(`/vcs/diff?mode=${mode}`,{directory});
      return {git:true,...info,status,diff};
    };
    void load().then(value=>{if(!stale&&!client.signal.aborted)setSnapshot(value);}).catch(error=>{if(!stale&&!client.signal.aborted){setFailed(true);onError(error);}}).finally(()=>{if(!stale&&!client.signal.aborted)setBusy(false);});
    return()=>{stale=true;};
  },[client,directory,mode,open,revision,onError]);
  return <details className="native-git-changes" onToggle={event=>setOpen(event.currentTarget.open)}><summary>{gt('title')}</summary>
    <div className="native-actions"><select aria-label={gt('title')} value={mode} onChange={event=>setMode(event.target.value as 'git'|'branch')}><option value="git">{gt('working')}</option><option value="branch">{gt('branch')}</option></select><Button variant="secondary" disabled={busy} onClick={()=>setRevision(value=>value+1)}>{gt('refresh')}</Button></div>
    {busy?<p>…</p>:snapshot?(!snapshot.git?<p>{gt('gitRequired')}</p>:<>
      <code dir="ltr">{snapshot.branch??'—'}{mode==='branch'&&snapshot.default_branch?` → ${snapshot.default_branch}`:''}</code>
      {mode==='git'&&<Button variant="secondary" disabled={busy} onClick={()=>void download()}>{nativeSessionText(locale,'patch')}</Button>}
      {mode==='branch'&&!snapshot.default_branch?<p>{gt('unavailable')}</p>:snapshot.diff.length?snapshot.diff.map((file,index)=><details key={`${file.file}:${index}`} data-native-git-file={file.file}><summary><bdi>{file.file}</bdi> <span dir="ltr">+{file.additions} −{file.deletions}</span></summary><pre dir="ltr" tabIndex={0} className="native-detail">{file.patch??`${file.file}: +${file.additions} −${file.deletions}`}</pre></details>):<p>{gt('empty')}</p>}
      {mode==='git'&&snapshot.status.some(file=>!snapshot.diff.some(diff=>diff.file===file.file))&&<ul>{snapshot.status.filter(file=>!snapshot.diff.some(diff=>diff.file===file.file)).map(file=><li key={file.file}><bdi>{file.file}</bdi> <span dir="ltr">+{file.additions} −{file.deletions}</span></li>)}</ul>}
    </>):failed?null:<p>…</p>}
  </details>;
}

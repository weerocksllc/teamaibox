import {useCallback,useEffect,useState} from 'react';
import {Button} from '@teamaibox/ui-system/components';
import type {Locale} from '../i18n';
import type {NativeClient,NativeFile,NativeFileContent,NativePty} from './native-client';
import {nativeText} from './native-copy';
import {NativeTerminal} from './NativeTerminal';
import {nativeFilePatch} from './native-file-patch';
import {NativeFileSearch} from './NativeFileSearch';
import {NativeGitChanges} from './NativeGitChanges';
import {nativeHistoryEditText} from './native-history-edit-copy';

export function NativeWorkspaceTools({client,directory,locale,onError,initialTab='files',onTabChange}:{client:NativeClient;directory:string;locale:Locale;onError:(error:unknown)=>void;initialTab?:'files'|'terminal';onTabChange?:(tab:'files'|'terminal')=>void}) {
  const nt=(key:Parameters<typeof nativeText>[1])=>nativeText(locale,key);
  const [tab,setTab]=useState<'files'|'terminal'>(initialTab);
  useEffect(()=>setTab(initialTab),[initialTab]);
  const [path,setPath]=useState('');
  const [files,setFiles]=useState<NativeFile[]>([]);
  const [file,setFile]=useState<{path:string;value:NativeFileContent}|null>(null);
  const [terminals,setTerminals]=useState<NativePty[]>([]);
  const [terminal,setTerminal]=useState<string|null>(null);
  const [shells,setShells]=useState<{path:string;name:string;acceptable:boolean}[]>([]);const [shell,setShell]=useState('');
  const [busy,setBusy]=useState(false);
  const [editing,setEditing]=useState(false);const [draft,setDraft]=useState('');const [patch,setPatch]=useState('');
  useEffect(()=>{
    let stale=false;setFiles([]);setFile(null);setEditing(false);setPatch('');
    void client.request<NativeFile[]>(`/file?path=${encodeURIComponent(path)}`,{directory}).then(value=>{if(!stale)setFiles(value);}).catch(error=>{if(!stale)onError(error);});
    return()=>{stale=true;};
  },[client,directory,path,onError]);
  const refreshTerminals=useCallback(async()=>{
    const value=await client.request<NativePty[]>('/pty',{directory});if(!client.signal.aborted){setTerminals(value);setTerminal(previous=>previous&&value.some(item=>item.id===previous)?previous:value.find(item=>item.status==='running')?.id??null);}
  },[client,directory]);
  useEffect(()=>{if(tab==='terminal')void refreshTerminals().catch(onError);},[tab,refreshTerminals,onError]);
  useEffect(()=>{if(tab!=='terminal')return;let stale=false;void client.request<typeof shells>('/pty/shells',{directory}).then(value=>{if(!stale&&!client.signal.aborted)setShells(value);}).catch(onError);return()=>{stale=true;};},[client,directory,tab,onError]);
  const create=async()=>{
    setBusy(true);
    try{const value=await client.request<NativePty>('/pty',{method:'POST',directory,body:{cwd:directory,...(shell?{command:shell}:{})}});setTerminal(value.id);await refreshTerminals();}
    catch(error){onError(error);}finally{setBusy(false);}
  };
  const end=async()=>{
    if(!terminal)return;setBusy(true);
    try{await client.request(`/pty/${encodeURIComponent(terminal)}`,{method:'DELETE',directory});setTerminal(null);await refreshTerminals();}
    catch(error){onError(error);}finally{setBusy(false);}
  };
  const open=async(item:NativeFile)=>{
    if(item.type==='directory'){setPath(item.path);return;}
    setBusy(true);
    try{const value=await client.request<NativeFileContent>(`/file/content?path=${encodeURIComponent(item.path)}`,{directory});if(value.type==='text')value.content=await client.readText(item.path,directory);setFile({path:item.path,value});setEditing(false);setPatch('');setDraft(value.content);}
    catch(error){onError(error);}finally{setBusy(false);}
  };
  const save=async()=>{
    if(!file||!patch)return;setBusy(true);
    try{
      // Never force a conflicting write; native git apply rejects stale contents.
      const result=await client.request<{applied:boolean}>('/vcs/apply',{method:'POST',directory,body:{patch}});
      if(!result.applied)throw Error('file_patch_not_applied');
      const value={...file.value,content:await client.readText(file.path,directory)};
      setFile({path:file.path,value});setDraft(value.content);setEditing(false);setPatch('');
    }catch(error){onError(error);}finally{setBusy(false);}
  };
  return <section className="native-workspace-tools">
    <nav className="native-actions" aria-label={nt('project')}>{(['files','terminal'] as const).map(value=><Button key={value} variant={tab===value?'primary':'secondary'} onClick={()=>{setTab(value);onTabChange?.(value);}} aria-pressed={tab===value}>{nt(value)}</Button>)}</nav>
    {tab==='files'?<>
      <NativeGitChanges client={client} directory={directory} locale={locale} onError={onError}/>
      <NativeFileSearch client={client} directory={directory} locale={locale} onOpen={item=>void open(item)} onError={onError}/>
      <div className="native-actions"><Button variant="secondary" disabled={!path||busy} onClick={()=>setPath(path.split('/').filter(Boolean).slice(0,-1).join('/'))}>{nt('back')}</Button><code>{directory}/{path}</code></div>
      <div className="native-file-layout"><ul className="native-file-list">{files.map(item=><li key={item.path}><button type="button" disabled={busy} onClick={()=>void open(item)}>{item.type==='directory'?'▸ ':''}{item.name}</button></li>)}</ul>
        {file&&<article><h3>{file.path}</h3>{file.value.type==='binary'||file.value.encoding==='base64'?<p>{nt('binary')} · {file.value.mimeType}</p>:<>
          {editing?<><textarea className="native-config-editor" aria-label={nt('edit')} value={draft} spellCheck={false} disabled={busy} onChange={e=>{setDraft(e.target.value);setPatch('');}}/><div className="native-actions"><Button variant="secondary" disabled={busy||draft===file.value.content} onClick={()=>{try{setPatch(nativeFilePatch(file.path,file.value.content,draft));}catch(error){onError(error);}}}>{nt('reviewChanges')}</Button><Button variant="primary" disabled={busy||!patch} onClick={()=>void save()}>{nt('save')}</Button></div>{patch&&<pre tabIndex={0}>{patch}</pre>}</>:<><pre tabIndex={0}>{file.value.content}</pre><Button variant="secondary" disabled={busy} onClick={()=>setEditing(true)}>{nt('edit')}</Button></>}
        </>}{file.value.diff&&<details><summary>{nt('changes')}</summary><pre>{file.value.diff}</pre></details>}</article>}
      </div>
    </>:<>
      <select aria-label={nativeHistoryEditText(locale,'shell')} disabled={busy} value={shell} onChange={event=>setShell(event.target.value)}><option value="">{nativeHistoryEditText(locale,'defaultShell')}</option>{shells.filter(item=>item.acceptable).map(item=><option key={item.path} value={item.path}>{item.name} · {item.path}</option>)}</select>
      <div className="native-actions"><Button variant="secondary" disabled={busy} onClick={()=>void create()}>+ {nt('terminal')}</Button><select aria-label={nt('terminal')} value={terminal??''} onChange={e=>setTerminal(e.target.value||null)}><option value="">{nt('terminal')}</option>{terminals.map(item=><option key={item.id} value={item.id}>{item.title} · {item.status}</option>)}</select><Button variant="secondary" disabled={busy||!terminal} onClick={()=>void end()}>{nt('closeTerminal')}</Button></div>
      {terminal&&<NativeTerminal key={terminal} client={client} id={terminal} directory={directory} locale={locale} onError={onError}/>}
    </>}
  </section>;
}

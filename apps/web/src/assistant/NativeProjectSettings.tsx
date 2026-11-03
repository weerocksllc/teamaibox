import {useState} from 'react';
import {Button} from '@teamaibox/ui-system/components';
import type {Locale} from '../i18n';
import type {NativeClient,NativeFile,NativePty} from './native-client';
import {nativeText} from './native-copy';
import {nativeProjectSettingsText} from './native-project-settings-copy';
import {nativeFilePatch} from './native-file-patch';
import {validateNativeConfig} from './native-config-validation';

/** Edit the native source file, never serialize the merged config (which includes
 * managed policy). Save and native instance reload are intentionally separate. */
export function NativeProjectSettings({client,directory,locale,onError,onReload}:{client:NativeClient;directory:string;locale:Locale;onError:(error:unknown)=>void;onReload:()=>void}){
  const nt=(key:Parameters<typeof nativeText>[1])=>nativeText(locale,key);
  const pt=(key:Parameters<typeof nativeProjectSettingsText>[1])=>nativeProjectSettingsText(locale,key);
  const [files,setFiles]=useState<string[]>([]);const [path,setPath]=useState('opencode.json');
  const [before,setBefore]=useState<string|null>(null);const [draft,setDraft]=useState('');
  const [patch,setPatch]=useState('');const [loaded,setLoaded]=useState(false);const [git,setGit]=useState(true);
  const [busy,setBusy]=useState(false);const [feedback,setFeedback]=useState('');
  const load=async(target?:string)=>{
    if(busy)return;setBusy(true);setFeedback('');
    try{
      const [project,entries]=await Promise.all([client.request<{vcs?:string}>('/project/current',{directory}),client.request<NativeFile[]>('/file?path=',{directory})]);
      // Do not treat a failed read (including upstream's missing-file 500) as an empty file.
      const existing=entries.filter(item=>item.type==='file'&&['opencode.json','opencode.jsonc'].includes(item.name)).map(item=>item.name);
      const selected=target??existing[0]??'opencode.json';
      const source=existing.includes(selected)?await client.readText(selected,directory):null;
      if(client.signal.aborted)return;
      setGit(project.vcs==='git');setFiles(existing.length?existing:['opencode.json']);setPath(selected);
      setBefore(source);setDraft(source??'{}\n');setPatch('');setLoaded(true);
    }catch(error){onError(error);}finally{if(!client.signal.aborted)setBusy(false);}
  };
  const review=()=>{
    try{
      validateNativeConfig(draft,path.endsWith('.jsonc'));
      setPatch(nativeFilePatch(path,before,draft));setFeedback('');
    }catch(error){onError(error);}
  };
  const save=async()=>{
    if(busy||!git||!patch)return;setBusy(true);setFeedback('');
    try{
      validateNativeConfig(draft,path.endsWith('.jsonc'));
      // Full-context native git apply rejects conflicts; no force/overwrite fallback.
      const result=await client.request<{applied:boolean}>('/vcs/apply',{method:'POST',directory,body:{patch}});
      if(!result.applied)throw Error('file_patch_not_applied');
      const saved=await client.readText(path,directory);
      if(saved!==draft)throw Error('configuration_changed_during_save');
      if(client.signal.aborted)return;
      setBefore(saved);setPatch('');setFeedback(pt('saved'));
    }catch(error){onError(error);}finally{if(!client.signal.aborted)setBusy(false);}
  };
  const reload=async()=>{
    if(busy)return;setBusy(true);setFeedback('');
    try{
      const [sessions,terminals,permissions,questions,v2]=await Promise.all([client.request<Record<string,{type:string}>>('/session/status',{directory}),client.request<NativePty[]>('/pty',{directory}),client.request<unknown[]>('/permission',{directory}),client.request<unknown[]>('/question',{directory}),client.request<{data:Record<string,unknown>}>('/api/session/active',{directory})]);
      if(Object.values(sessions).some(item=>item.type!=='idle')||terminals.some(item=>item.status==='running')||permissions.length||questions.length||Object.keys(v2.data).length){setFeedback(pt('reloadBlocked'));return;}
      await client.request('/instance/dispose',{method:'POST',directory});
      // A successful write/dispose is not proof that the config can be loaded.
      await client.request('/config',{directory});
      if(client.signal.aborted)return;
      setFeedback(pt('loaded'));onReload();
    }catch(error){onError(error);}finally{if(!client.signal.aborted)setBusy(false);}
  };
  const dirty=loaded&&draft!==(before??'{}\n');
  return <section className="native-project-settings">
    <div className="native-actions"><Button variant="secondary" disabled={busy||dirty} onClick={()=>void load()}>{pt('edit')}</Button><Button variant="secondary" disabled={busy||dirty||Boolean(patch)} onClick={()=>void reload()}>{pt('reload')}</Button></div>
    {feedback&&<p role="status">{feedback}</p>}
    {loaded&&(!git?<p>{pt('gitRequired')}</p>:<>
      <p>{pt('warning')}</p>
      <select aria-label={pt('source')} disabled={busy||dirty} value={path} onChange={event=>void load(event.target.value)}>{files.map(file=><option key={file}>{file}</option>)}</select>
      <textarea className="native-config-editor" aria-label={pt('source')} dir="ltr" spellCheck={false} disabled={busy} rows={10} value={draft} onChange={event=>{setDraft(event.target.value);setPatch('');setFeedback('');}}/>
      <div className="native-actions"><Button variant="secondary" disabled={busy||draft===before} onClick={review}>{nt('reviewChanges')}</Button><Button variant="primary" disabled={busy||!patch} onClick={()=>void save()}>{nt('save')}</Button></div>
      {patch&&<pre className="native-detail" tabIndex={0} dir="ltr">{patch}</pre>}
    </>)}
  </section>;
}

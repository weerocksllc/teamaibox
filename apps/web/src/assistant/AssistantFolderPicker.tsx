import {useEffect,useState} from 'react';
import {Button} from '@teamaibox/ui-system/components';
import {EditorDialog} from '../EditorDialog';
import type {Locale} from '../i18n';
import {nativeFilePart,type NativeClient,type NativeFile} from './native-client';
import {nativeText} from './native-copy';
import {projectSessionText,projectFeedbackText,projectImportLimitText} from './project-session-copy';
import {AssistantDesignIcon as Icon} from './AssistantDesignIcon';
import {canonicalWorkspace} from './assistant-browser-state';

export function AssistantFolderPicker({client,directory,locale,mode,onOpen,onCancel,t}:{client:NativeClient;directory:string;locale:Locale;mode:'open'|'create';onOpen:(path:string)=>void;onCancel:()=>void;t:(key:string)=>string}){
  const pt=(key:Parameters<typeof projectSessionText>[1])=>projectSessionText(locale,key);
  const [path,setPath]=useState(directory),[items,setItems]=useState<NativeFile[]>([]),[create,setCreate]=useState(mode==='create');
  const [name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [result,setResult]=useState<{name:string;status:string}[]>([]);
  const validName=Boolean(name.trim()&&!/[\\/\0-\x1f]/.test(name)&&!name.trim().startsWith('.')&&name.trim().length<=128);
  useEffect(()=>{let stale=false;setItems([]);setError('');void client.request<NativeFile[]>('/file?path=',{directory:path}).then(value=>{if(!stale)setItems(value.filter(i=>i.type==='directory'&&canonicalWorkspace(i.absolute)&&!i.name.startsWith('.')));}).catch(()=>{if(!stale)setError(t('assistant.workspace.error'));});return()=>{stale=true;};},[client,path,t]);
  const submit=async()=>{
    if(busy)return;if(!create){onOpen(path);return;}if(!validName)return;setBusy(true);setError('');
    try{const value=await client.workspace<{directory:string}>('folders',{directory:path,name:name.trim()});onOpen(value.directory);}catch{setError(t('assistant.workspace.error'));}finally{setBusy(false);}
  };
  const upload=async(files:File[])=>{
    if(files.length>100){setError(projectImportLimitText(locale));return;}
    setBusy(true);setError('');setResult([]);
    const outcomes:{name:string;status:string}[]=[];
    for(const file of files.slice(0,100)){
      if(file.size>16*1024*1024){outcomes.push({name:file.name,status:projectFeedbackText(locale,'tooLarge')});continue;}
      try{const part=await nativeFilePart(file);const response=await client.workspace<{status:'created'|'exists'}>('files',{directory:path,name:file.name,content:part.url.slice(part.url.indexOf(',')+1)});
        outcomes.push({name:file.name,status:response.status==='created'?'✓':projectFeedbackText(locale,'exists')});
      }catch{outcomes.push({name:file.name,status:t('assistant.workspace.error')});}
    }
    setResult(outcomes);setBusy(false);
  };
  return <EditorDialog title={pt(create?'newProject':'openFolder')} description={pt('workspace')} closeLabel={t('common.close')} busy={busy} onCancel={onCancel} feedback={error}>
    <form className="assistant-folder-picker" onSubmit={e=>{e.preventDefault();void submit();}}>
      <nav aria-label={pt('openFolder')} className="assistant-folder-breadcrumbs">{path.split('/').filter(Boolean).map((part,i,parts)=><Button type="button" key={i} variant="quiet" disabled={busy} onClick={()=>setPath('/'+parts.slice(0,i+1).join('/'))}>{part}</Button>)}</nav>
      <ul className="native-file-list">{items.map(item=><li key={item.absolute}><Button type="button" variant="quiet" disabled={busy} onClick={()=>setPath(item.absolute)}><Icon name="folder"/><span>{item.name}</span></Button></li>)}</ul>
      {!create&&<Button variant="quiet" disabled={busy} onClick={()=>setCreate(true)}><Icon name="plus"/>{pt('newProject')}</Button>}
      {create&&<label>{pt('folderName')}<input value={name} disabled={busy} autoComplete="off" onChange={e=>setName(e.target.value)}/></label>}
      <p>{pt('importHint')} <span dir="ltr">16 MiB / {nativeText(locale,'files')} · 100</span></p>
      <ul className="assistant-import-results" aria-live="polite">{result.map((r,i)=><li key={i}>{r.name} · {r.status}</li>)}</ul>
      <footer><label className="assistant-import-button">{pt('importFiles')}<input type="file" multiple disabled={busy} aria-label={pt('importFiles')} onChange={e=>{const files=Array.from(e.target.files??[]);e.target.value='';void upload(files);}}/></label><Button variant="quiet" disabled={busy} onClick={onCancel}>{t('common.cancel')}</Button><Button type="submit" variant="primary" busy={busy} disabled={create&&!validName}>{pt(create?'create':'openFolder')}</Button></footer>
    </form>
  </EditorDialog>;
}

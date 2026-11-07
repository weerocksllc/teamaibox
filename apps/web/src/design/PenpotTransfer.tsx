import {useEffect,useRef,useState,type RefObject} from 'react';
import {Download,ImagePlus,Upload} from 'lucide-react';
import {Button} from '@teamaibox/ui-system/components';
import {EditorDialog} from '../EditorDialog';
import type {Locale} from '../i18n';
import {transferText} from './penpot-transfer-copy';

const editor='/api/v1/design/editor/';
const drive=editor+'_integration/drive/';
const files='/api/v1/files/';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const raster={'png':'image/png','jpg':'image/jpeg','jpeg':'image/jpeg','webp':'image/webp'} as const;
const imageType=(name:string)=>{
  const ext=name.toLowerCase().split('.').at(-1) as keyof typeof raster;
  return Object.hasOwn(raster,ext)?raster[ext]:null;
};
type Mode='import'|'export';
type Format='penpot'|'png'|'pdf';
type Target={fileId:string;pageId:string};
type Named={id:string;name:string};
type Root={id:string;scope_kind:string;scope_key:string};
type Entry=Named&{kind:string;revision:number};
type Version={version:number};
type Saved={revision:number;documentVersion:number;frames:Named[]};
type Pending={mode:Mode;request:Record<string,unknown>};
type Feedback='done'|'failed'|'pending';
type Translate=(key:string)=>string;
const validId=(value:string)=>uuid.test(value);
class TransferHttpError extends Error{
  constructor(readonly status:number){super('transfer');}
}

function unwrap<T>(value:unknown):T[]{
  if(Array.isArray(value))return value;
  if(value&&typeof value==='object'&&'data' in value&&Array.isArray(value.data))return value.data;
  throw Error('list');
}

async function request(path:string,payload?:Record<string,unknown>,signal?:AbortSignal){
  const headers:Record<string,string>=path.startsWith(editor+'api/main/methods/')?{accept:'application/json'}:{};
  if(payload){
    const tokens=document.cookie.split(';').map(value=>value.trim()).filter(value=>value.startsWith('__Host-teamaibox-csrf='));
    if(tokens.length!==1)throw Error('session');
    headers['x-csrf-token']=tokens[0].slice(tokens[0].indexOf('=')+1);
    headers['content-type']='application/json';
  }
  const response=await fetch(path,{headers,credentials:'same-origin',redirect:'error',cache:'no-store',
    method:payload?'POST':'GET',body:payload?JSON.stringify(payload):undefined,
    signal:signal?AbortSignal.any([signal,AbortSignal.timeout(60_000)]):AbortSignal.timeout(60_000)});
  if(!response.ok)throw new TransferHttpError(response.status);
  return response;
}
async function json(path:string,payload?:Record<string,unknown>,signal?:AbortSignal){return (await request(path,payload,signal)).json();}

function locationInEditor(frame:HTMLIFrameElement|null):Target|null{
  try{
    const location=frame?.contentWindow?.location;
    if(location?.origin!==window.location.origin||location.pathname!==editor)return null;
    const [route,query]=location.hash.slice(1).split('?',2);
    if(route!=='/workspace')return null;
    const params=new URLSearchParams(query),fileId=params.get('file-id')??'',pageId=params.get('page-id')??'';
    return validId(fileId)&&validId(pageId)?{fileId,pageId}:null;
  }catch{return null;}
}
const same=(a:Target|null,b:Target|null)=>!!a&&!!b&&a.fileId===b.fileId&&a.pageId===b.pageId;

async function insertImage(frame:HTMLIFrameElement|null,target:Target,file:File){
  if(!file.size||file.size>32*1024*1024||file.type!==imageType(file.name))throw Error('image');
  const bytes=new Uint8Array(await file.slice(0,12).arrayBuffer());
  const hex=Array.from(bytes,v=>v.toString(16).padStart(2,'0')).join('');
  if(!(file.type==='image/png'?hex.startsWith('89504e470d0a1a0a'):file.type==='image/jpeg'?hex.startsWith('ffd8ff')
    :file.type==='image/webp'&&hex.startsWith('52494646')&&hex.endsWith('57454250')))throw Error('image');
  if(!same(locationInEditor(frame),target))throw Error('target changed');
  const doc=frame?.contentDocument;
  const input=doc?.getElementById('image-upload');
  if(!doc||!input||input.tagName!=='INPUT'||(input as HTMLInputElement).type!=='file')throw Error('editor unavailable');
  const native=doc.defaultView as (Window & typeof globalThis)|null;
  if(!native)throw Error('editor unavailable');
  const transfer=new native.DataTransfer();
  transfer.items.add(new native.File([file],file.name,{type:file.type,lastModified:file.lastModified}));
  (input as HTMLInputElement).files=transfer.files;
  // Reuse the native editor upload and its existing save/permission handling.
  input.dispatchEvent(new native.Event('change',{bubbles:true}));
}

export function PenpotTransfer({frame,identityId,locale,t,ready}:{frame:RefObject<HTMLIFrameElement|null>;identityId:string;
  locale:Locale;t:Translate;ready:boolean}){
  const text=(key:Parameters<typeof transferText>[1])=>transferText(locale,key);
  const [mode,setMode]=useState<Mode|null>(null),[feedback,setFeedback]=useState<Feedback|null>(null);
  const [target,setTarget]=useState<Target|null>(null);
  const [pending,setPending]=useState<Pending|null>(null);
  const fileInput=useRef<HTMLInputElement>(null),imageTarget=useRef<Target|null>(null);
  const key='teamaibox.design.transfer.v1:'+identityId;
  useEffect(()=>{
    setMode(null);setTarget(null);setFeedback(null);setPending(null);
    try{
      const stored=JSON.parse(sessionStorage.getItem(key)??'null');
      if((stored?.mode==='import'||stored?.mode==='export')&&validId(stored.request?.operationId)){
        setPending(stored);setFeedback('pending');
      }
    }catch{/* Storage may be disabled; recovery remains available until refresh. */}
  },[key]);
  const remember=(value:Pending|null)=>{
    setPending(value);
    try{if(value)sessionStorage.setItem(key,JSON.stringify(value));else sessionStorage.removeItem(key);}catch{/* optional */}
  };
  const open=(next:Mode)=>{
    const current=locationInEditor(frame.current);
    if(next==='export'&&!current&&!pending){setFeedback(null);setTarget(null);setMode(next);return;}
    setTarget(current);setFeedback(pending?'pending':null);setMode(pending?.mode??next);
  };
  return <>
    <div className="penpot-transfer-actions">
      <Button variant="quiet" disabled={!ready} onClick={()=>open('import')}><Upload size={16}/>{text('import')}</Button>
      <Button variant="quiet" disabled={!ready} onClick={()=>open('export')}><Download size={16}/>{text('export')}</Button>
      <Button variant="quiet" disabled={!ready} onClick={()=>{
        imageTarget.current=locationInEditor(frame.current);setFeedback(null);
        if(imageTarget.current)fileInput.current?.click();else setFeedback('failed');
      }}><ImagePlus size={16}/>{text('image')}</Button>
      <input ref={fileInput} hidden type="file" accept="image/png,image/jpeg,image/webp" onChange={event=>{
        const file=event.currentTarget.files?.[0],picked=imageTarget.current;
        event.currentTarget.value='';imageTarget.current=null;
        if(file&&picked)void insertImage(frame.current,picked,file).catch(()=>setFeedback('failed'));
      }}/>
      {!mode&&feedback&&<small role="status">{text(feedback)}</small>}
      {!mode&&pending&&<Button variant="quiet" onClick={()=>open(pending.mode)}>{text('verify')}</Button>}
    </div>
    {mode&&<TransferDialog key={mode} {...{mode,locale,t,frame,target,pending,remember,feedback,setFeedback}} onClose={()=>setMode(null)}/>}
  </>;
}

function TransferDialog({mode,locale,t,frame,target,pending,remember,feedback,setFeedback,onClose}:{
  mode:Mode;locale:Locale;t:Translate;frame:RefObject<HTMLIFrameElement|null>;target:Target|null;
  pending:Pending|null;remember:(value:Pending|null)=>void;feedback:Feedback|null;setFeedback:(value:Feedback|null)=>void;onClose:()=>void;
}){
  const text=(key:Parameters<typeof transferText>[1])=>transferText(locale,key);
  const [roots,setRoots]=useState<Root[]>([]),[root,setRoot]=useState('');
  const [folders,setFolders]=useState<Named[]>([]),[entries,setEntries]=useState<Entry[]>([]);
  const [file,setFile]=useState<Entry|null>(null),[versions,setVersions]=useState<Version[]>([]),[version,setVersion]=useState(0);
  const [teams,setTeams]=useState<Named[]>([]),[team,setTeam]=useState('');
  const [projects,setProjects]=useState<Named[]>([]),[project,setProject]=useState('');
  const [format,setFormat]=useState<Format>('png'),[name,setName]=useState(''),[frameId,setFrameId]=useState('');
  const [saved,setSaved]=useState<Saved|null>(null),[busy,setBusy]=useState(false),[listing,setListing]=useState(true);
  const [completedVersion,setCompletedVersion]=useState<number|null>(null);
  const parentId=folders.at(-1)?.id??null;
  const blocked=!!pending;
  const title=text(mode);
  const resetFile=()=>{setFile(null);setVersion(0);setVersions([]);};
  useEffect(()=>{
    if(blocked||(mode==='export'&&!target))return;
    const c=new AbortController();
    void json(files+'bootstrap',undefined,c.signal).then(value=>{
      const available=unwrap<Root>(value).filter(item=>item.scope_kind==='team'&&validId(item.id));
      setRoots(available);setRoot(available[0]?.id??'');
    }).catch(()=>{if(!c.signal.aborted)setFeedback('failed');});
    if(mode==='import')void json(editor+'api/main/methods/get-teams',{},c.signal).then(value=>{
      const available=unwrap<Named>(value).filter(item=>validId(item.id));
      setTeams(available);setTeam(available[0]?.id??'');
    }).catch(()=>{if(!c.signal.aborted)setFeedback('failed');});
    return ()=>c.abort();
  },[mode,target,blocked,setFeedback]);
  useEffect(()=>{
    if(blocked||!root)return;
    const c=new AbortController();
    setListing(true);setEntries([]);
    void json(files+'roots/'+root+'/entries'+(parentId?'?parent_id='+parentId:''),undefined,c.signal).then(value=>{
      setEntries(unwrap<Entry>(value).filter(item=>validId(item.id)));setListing(false);
    }).catch(()=>{if(!c.signal.aborted){setListing(false);setFeedback('failed');}});
    return ()=>c.abort();
  },[root,parentId,blocked,setFeedback]);
  useEffect(()=>{
    if(blocked||mode!=='import'||!file)return;
    const c=new AbortController();
    void json(files+'entries/'+file.id+'/versions',undefined,c.signal).then(value=>{
      setVersions(unwrap<Version>(value).filter(item=>Number.isSafeInteger(item.version)&&item.version>0).sort((a,b)=>b.version-a.version));
    }).catch(()=>{if(!c.signal.aborted)setFeedback('failed');});
    return ()=>c.abort();
  },[file,mode,blocked,setFeedback]);
  useEffect(()=>{
    if(blocked||!team)return;
    const c=new AbortController();
    setProjects([]);setProject('');
    void json(editor+'api/main/methods/get-projects',{'team-id':team},c.signal).then(value=>{
      setProjects(unwrap<Named>(value).filter(item=>validId(item.id)));
    }).catch(()=>{if(!c.signal.aborted)setFeedback('failed');});
    return ()=>c.abort();
  },[team,blocked,setFeedback]);
  const derivative=format!=='penpot';
  useEffect(()=>{
    if(blocked||mode!=='export'||!target)return;
    const c=new AbortController();
    setSaved(null);setFrameId('');
    void json(drive+'revision',{...target,includeFrames:derivative},c.signal).then(setSaved)
      .catch(()=>{if(!c.signal.aborted)setFeedback('failed');});
    return ()=>c.abort();
  },[mode,target,derivative,blocked,setFeedback]);

  const importType=file&&imageType(file.name);
  const usable=mode==='import'?!!(file&&version&&(importType?target:project)):
    !!(target&&saved&&root&&!listing&&(!derivative||frameId)&&(file||name.trim()));
  const settle=async(value:Pending,observeOnly:boolean)=>{
    setBusy(true);setFeedback(null);
    try{
      const reply=await json(drive+value.mode,{...value.request,observeOnly});
      if(reply?.operationId!==value.request.operationId)throw Error('receipt');
      if(reply.state==='complete'){
        remember(null);setCompletedVersion(Number.isSafeInteger(reply.version)?reply.version:null);setFeedback('done');
      }else if(reply.state==='failed'||reply.state==='not_started'){
        remember(null);setFeedback('failed');
      }else setFeedback('pending');
    }catch(error){
      if(!observeOnly&&error instanceof TransferHttpError&&[400,401,403,404,409,413,415,422].includes(error.status)){
        remember(null);setFeedback('failed');
      }else setFeedback('pending');
    }
    finally{setBusy(false);}
  };
  const submit=async()=>{
    if(!usable||busy||blocked)return;
    const operationId=crypto.randomUUID();
    if(mode==='import'&&file){
      const source={fileId:file.id,version};
      if(importType&&target){
        setBusy(true);setFeedback(null);
        try{
          if(!same(locationInEditor(frame.current),target))throw Error('target changed');
          const response=await request(drive+'image',{...target,source,format:importType});
          const blob=await response.blob();
          await insertImage(frame.current,target,new File([blob],file.name,{type:blob.type}));
          onClose();
        }catch{setFeedback('failed');}finally{setBusy(false);}
      }else{
        const value:Pending={mode,request:{operationId,source,projectId:project}};
        remember(value);await settle(value,false);
      }
    }else if(mode==='export'&&saved&&target){
      if(!same(locationInEditor(frame.current),target)){setFeedback('failed');return;}
      const value:Pending={mode,request:{operationId,
        source:{...target,revision:saved.revision,documentVersion:saved.documentVersion,format,...(derivative?{objectId:frameId}:{})},
        target:{rootId:root,parentId,...(file?{fileId:file.id,expectedRevision:file.revision}:
          {name:name.trim().toLowerCase().endsWith('.'+format)?name.trim():name.trim()+'.'+format})}}};
      remember(value);await settle(value,false);
    }
  };
  const visible=entries.filter(item=>item.kind==='folder'||(mode==='import'?(imageType(item.name)||item.name.toLowerCase().endsWith('.penpot')):item.name.toLowerCase().endsWith('.'+format)));
  return <EditorDialog title={title} busy={busy} closeLabel={t('common.close')} onCancel={onClose}
    feedback={feedback&&<>{text(feedback)}{completedVersion!==null&&feedback==='done'?' · '+text('version')+' '+completedVersion:''}</>}>
    {pending?<Button disabled={busy} onClick={()=>void settle(pending,true)}>{text('verify')}</Button>:
    feedback==='done'?null:
    mode==='export'&&!target?<p>{text('openFile')}</p>:
    <form className="penpot-transfer-form" onSubmit={event=>{event.preventDefault();void submit();}}>
      <label>{text('folder')}<select aria-label={text('folder')} value={root} onChange={event=>{setRoot(event.target.value);setFolders([]);resetFile();}}>
        {!roots.length&&<option value="">—</option>}{roots.map(item=><option value={item.id} key={item.id}>{item.scope_key}</option>)}
      </select></label>
      {root&&<div className="penpot-transfer-path">
        <Button type="button" variant="quiet" onClick={()=>{setFolders([]);resetFile();}}>{roots.find(item=>item.id===root)?.scope_key}</Button>
        {folders.map((folder,index)=><Button type="button" variant="quiet" key={folder.id} onClick={()=>{setFolders(folders.slice(0,index+1));resetFile();}}>{folder.name}</Button>)}
      </div>}
      {root&&<div className="penpot-transfer-files" aria-busy={listing}>
        {visible.map(item=><Button type="button" variant="quiet" key={item.id} aria-pressed={item.kind==='folder'?undefined:file?.id===item.id}
          onClick={()=>{resetFile();if(item.kind==='folder')setFolders([...folders,item]);else setFile(item);}}>
          {item.kind==='folder'?'▸ ':''}{item.name}</Button>)}
        {!visible.length&&<span>{listing?t('applications.loading'):'—'}</span>}
      </div>}
      {mode==='import'?<>
        {file&&<label>{text('version')}<select aria-label={text('version')} value={version} onChange={event=>setVersion(Number(event.target.value))}>
          <option value={0}>—</option>{versions.map(value=><option key={value.version} value={value.version}>{value.version}</option>)}
        </select></label>}
        {file&&!importType&&<><p>{text('copy')}</p><label>{text('project')}<select value={team} onChange={event=>setTeam(event.target.value)}>
          {!teams.length&&<option value="">—</option>}{teams.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label><label>{text('project')}<select value={project} onChange={event=>setProject(event.target.value)}>
          <option value="">—</option>{projects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label></>}
        {importType&&!target&&<p>{text('openFile')}</p>}
      </>:<>
        <label><select aria-label="PNG / PDF / Penpot" value={format} onChange={event=>{setFormat(event.target.value as Format);resetFile();}}>
          <option value="png">PNG</option><option value="pdf">PDF</option><option value="penpot">Penpot</option>
        </select></label>
        {derivative&&<label>{text('frame')}<select aria-label={text('frame')} value={frameId} onChange={event=>setFrameId(event.target.value)}>
          <option value="">—</option>{saved?.frames?.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}
        </select></label>}
        <label>{text('name')}<input value={name} maxLength={240} onChange={event=>{setName(event.target.value);resetFile();}}/></label>
        {file&&<p>{text('append')}: {file.name}</p>}
      </>}
      <Button type="submit" disabled={!usable||busy||listing}>{file&&mode==='export'?text('append'):text('submit')}</Button>
    </form>}
  </EditorDialog>;
}

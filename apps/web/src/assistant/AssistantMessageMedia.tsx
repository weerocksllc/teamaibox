import {useEffect,useMemo,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Button} from '@teamaibox/ui-system/components';
import {EditorDialog} from '../EditorDialog';
import {dataBytes,mediaSource,safeRaster,type MediaSource} from './message-media';
import {useRichMessageContext} from './rich-message-context';
import {richMessageText} from './rich-message-copy';

export function AssistantImage({src,alt,mime}:{src:string;alt?:string;mime?:string}){
  const {client,directory,scopeKey,locale}=useRichMessageContext();
  const t=(key:Parameters<typeof richMessageText>[1])=>richMessageText(locale,key);
  const source=useMemo(()=>mediaSource(src,directory),[src,directory]);
  const key=scopeKey+'\0'+src;
  const [state,setState]=useState<{key:string;url?:string;failed?:boolean}>({key});
  const [open,setOpen]=useState(false);
  useEffect(()=>{
    const controller=new AbortController();let objectUrl:string|undefined,disposed=false;
    setOpen(false);setState({key});
    if(source.kind!=='data'&&source.kind!=='workspace')return ()=>controller.abort();
    void (async()=>{
      const bytes=source.kind==='data'?dataBytes(source):await client.readWorkspaceBytes(source.path,controller.signal);
      const type=safeRaster(bytes,source.kind==='data'?source.mime:mime);
      if(disposed||controller.signal.aborted)return;
      objectUrl=URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>],{type}));setState({key,url:objectUrl});
    })().catch(()=>{if(!disposed&&!controller.signal.aborted)setState({key,failed:true});});
    return ()=>{disposed=true;controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[client,key,source,mime]);
  if(source.kind==='external')return <span className="assistant-media-fallback"><span>{alt||t('image')} · {source.host}</span><a href={source.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{t('external')}</a></span>;
  const url=state.key===key?state.url:undefined;
  const failed=source.kind==='unavailable'||(state.key===key&&state.failed);
  return <span className="assistant-image" data-media-state={failed?'error':url?'ready':'loading'}>
    {url?<button type="button" className="assistant-image-button" aria-label={`${t('preview')}: ${alt||t('image')}`} onClick={()=>setOpen(true)}><img src={url} alt={alt||t('image')} loading="lazy" onError={()=>setState({key,failed:true})}/></button>:<span role="status">{alt||t('image')} · {failed?t('unavailable'):t('loading')}</span>}
    {open&&url&&createPortal(<EditorDialog title={alt||t('image')} closeLabel={t('close')} busy={false} onCancel={()=>setOpen(false)}><img className="assistant-image-preview" src={url} alt={alt||t('image')}/></EditorDialog>,document.body)}
  </span>;
}

export function AssistantAttachment({url='',filename,mime}:{url?:string;filename?:string;mime?:string}){
  const {client,directory,scopeKey,locale}=useRichMessageContext();
  const t=(key:Parameters<typeof richMessageText>[1])=>richMessageText(locale,key);
  const source=useMemo(()=>mediaSource(url,directory),[url,directory]);
  const lifetime=useRef(new AbortController());
  const [state,setState]=useState<'idle'|'loading'|'error'>('idle');
  useEffect(()=>{const current=new AbortController();lifetime.current=current;setState('idle');return ()=>current.abort();},[scopeKey,url]);
  const image=Boolean(mime?.startsWith('image/'));
  if(image)return <div className="assistant-attachment-preview"><AssistantImage src={url} alt={filename} mime={mime}/>{filename&&<small>{filename}</small>}</div>;
  async function download(source:MediaSource){
    if(source.kind!=='data'&&source.kind!=='workspace')return;
    const signal=lifetime.current.signal;setState('loading');
    try{
      const bytes=source.kind==='data'?dataBytes(source):await client.readWorkspaceBytes(source.path,signal);
      if(signal.aborted)return;
      const objectUrl=URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>],{type:'application/octet-stream'}));
      const link=document.createElement('a');link.href=objectUrl;link.download=(filename||t('file')).split(/[\\/]/).at(-1)!.replace(/[\u0000-\u001f\u007f]/g,'');link.click();URL.revokeObjectURL(objectUrl);setState('idle');
    }catch{if(!signal.aborted)setState('error');}
  }
  return <div className="assistant-file-card"><div><strong>{filename||t('file')}</strong><small>{mime||t('file')}</small></div>
    {(source.kind==='workspace'||source.kind==='data')&&<Button variant="quiet" disabled={state==='loading'} onClick={()=>void download(source)}>{state==='loading'?t('loading'):t('download')}</Button>}
    {(state==='error'||source.kind==='unavailable')&&<span role="status">{t('unavailable')}</span>}
    {source.kind==='external'&&<a href={source.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{source.host}</a>}
  </div>;
}

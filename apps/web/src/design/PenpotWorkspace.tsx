import {useCallback,useEffect,useRef,useState,type CSSProperties} from 'react';
import {ArrowLeft,MessageSquare,Link2,Unlink,RefreshCw,Layers,SlidersHorizontal,Ellipsis} from 'lucide-react';
import {Button} from '@teamaibox/ui-system/components';
import type {Locale} from '../i18n';
import {NativeAssistantWorkspace} from '../assistant/NativeAssistantWorkspace';
import {penpotText} from './penpot-copy';
import {penpotReopenCopy,penpotReviewCopy} from './penpot-review-copy';
import {PenpotTransfer} from './PenpotTransfer';
import {PenpotTeamSpaces} from './PenpotTeamSpaces';
import {observeCanvas,type CanvasPanel,type CanvasFile} from './penpot-canvas';
import {observePenpotPresentation} from './penpot-presentation';
import {canvasCopy} from './penpot-canvas-copy';
import canvasStyles from './penpot-canvas.css?url&no-inline';
import './penpot-workspace.css';

type Translator=(key:string,values?:Record<string,string|number>)=>string;
type DesignTarget={fileId:string;pageId:string};
type WriteReview={reviewId:string;state:'pending'|'uncertain';target:DesignTarget|null};
type DesignStatus={state:'disconnected'|'connecting'|'connected';reason:string;generation:number;selectable:boolean;sessionID:string|null;target:DesignTarget|null;review:WriteReview|null};
const initial:DesignStatus={state:'disconnected',reason:'',generation:0,selectable:false,sessionID:null,target:null,review:null};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Native Penpot stays mounted when the existing React assistant is folded.
 * It owns canvas/save state. This view owns only explicit AI target selection. */
export function PenpotWorkspace({identityId,locale,onClose,t}:{identityId:string;locale:Locale;onClose:()=>void;t:Translator}){
  const text=(key:Parameters<typeof penpotText>[1])=>penpotText(locale,key);
  const frame=useRef<HTMLIFrameElement>(null),current=useRef(initial),session=useRef<string|null>(null);
  const [source,setSource]=useState(''),[failed,setFailed]=useState(false),[attempt,setAttempt]=useState(0);
  const [waiting,setWaiting]=useState(false),[editorGeneration,setEditorGeneration]=useState(0);
  const [presented,setPresented]=useState(false);
  const editorLoaded=editorGeneration>0;
  const [status,setStatus]=useState(initial),[active,setActive]=useState<string|null>(null),[showAssistant,setShowAssistant]=useState(false);
  const [assistantOpened,setAssistantOpened]=useState(false);
  const [canvas,setCanvas]=useState<CanvasFile|null>(null),[panel,setPanel]=useState<CanvasPanel>(null),[actions,setActions]=useState(false);
  const native=useRef<ReturnType<typeof observeCanvas>>(undefined);
  const fileId=canvas?.id;
  const [backLabel,layersLabel,propertiesLabel,actionsLabel]=canvasCopy[locale];
  useEffect(()=>{setPanel(null);setActions(false);},[fileId]);
  useEffect(()=>{
    if(!source||!editorLoaded||!frame.current)return;
    return observePenpotPresentation(frame.current,()=>setPresented(true));
  },[source,editorLoaded,editorGeneration]);
  useEffect(()=>{
    if(!source||presented||failed)return;
    const deadline=setTimeout(()=>setFailed(true),30_000);
    return ()=>clearTimeout(deadline);
  },[source,presented,failed]);
  useEffect(()=>{
    if(!editorLoaded||!frame.current)return;
    const iframe=frame.current;
    native.current=observeCanvas(iframe,canvasStyles,next=>setCanvas(before=>
      before?.id===next?.id&&before?.name===next?.name&&before?.saveText===next?.saveText&&before?.saved===next?.saved?before:next));
    const dismiss=()=>setPanel(null);
    iframe.addEventListener('design-panel-dismiss',dismiss);
    return()=>{iframe.removeEventListener('design-panel-dismiss',dismiss);native.current?.dispose();native.current=undefined;};
  },[editorGeneration,editorLoaded,source]);
  useEffect(()=>{native.current?.setPanel(panel);},[panel,fileId]);
  const [width,setWidth]=useState(440);
  const command=useCallback((action:string,extra:Record<string,unknown>={})=>{
    frame.current?.contentWindow?.postMessage({type:'teamaibox.design.command/v1',requestId:crypto.randomUUID(),action,...extra},location.origin);
  },[]);
  const selectSession=useCallback((id:string|null)=>{
    const changed=session.current!==id;
    session.current=id;setActive(id);
    // Cancel an in-flight selection too, before it can bind the old session.
    if(changed&&current.current.state!=='disconnected')command('disconnect');
  },[command]);
  useEffect(()=>{
    const receive=(event:MessageEvent)=>{
      const value=event.data;
      if(event.origin!==location.origin||event.source!==frame.current?.contentWindow||value?.type!=='teamaibox.design.status/v1'
        ||!['disconnected','connecting','connected'].includes(value.state)||!Number.isSafeInteger(value.generation)||value.generation<0
        ||typeof value.selectable!=='boolean'||!(value.sessionID===null||typeof value.sessionID==='string')||typeof value.reason!=='string')return;
      const review=value.review;
      if(review!=null&&(!uuid.test(review.reviewId??'')||!['pending','uncertain'].includes(review.state)
        ||(review.target!==null&&(!uuid.test(review.target?.fileId??'')||!uuid.test(review.target?.pageId??'')))))return;
      current.current={...value,review:review??null};setStatus(current.current);
      // Switching the native assistant session never silently retargets AI.
      if(value.sessionID&&value.sessionID!==session.current)command('disconnect');
    };
    window.addEventListener('message',receive);return()=>{command('disconnect');window.removeEventListener('message',receive);};
  },[command]);
  useEffect(()=>{
    const abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    setFailed(false);setSource('');setWaiting(false);setEditorGeneration(0);setPresented(false);setCanvas(null);current.current=initial;setStatus(initial);
    const cookies=document.cookie.split(';').map(v=>v.trim()).filter(v=>v.startsWith('__Host-teamaibox-csrf='));
    if(cookies.length!==1){setFailed(true);return;}
    const headers={'x-csrf-token':cookies[0].slice(cookies[0].indexOf('=')+1)};
    const retry=()=>{if(!abort.signal.aborted){setWaiting(true);timer=setTimeout(()=>void observe(),3000);}};
    const observe=async()=>{
      let readiness;
      try{readiness=await fetch('/api/v1/design/status',{method:'POST',credentials:'same-origin',redirect:'error',
        signal:AbortSignal.any([abort.signal,AbortSignal.timeout(5000)]),headers:{...headers,'content-type':'application/json'},body:'{}'});}
      catch{retry();return;}
      if(abort.signal.aborted)return;
      if(readiness.status>=500){retry();return;}
      if(!readiness.ok){setFailed(true);return;}
      try{
        const value=await readiness.json();
        if(value.editor==='unavailable'){retry();return;}
        if(value.editor!=='ready')throw Error('status');
        // Only readiness observations retry automatically. A failed login
        // exchange requires the explicit Retry action, never a hidden replay.
        const r=await fetch('/api/v1/design/enter',{method:'POST',credentials:'same-origin',redirect:'error',signal:abort.signal,headers});
        if(!r.ok)throw Error('entry');const entry=await r.json();
        if(entry.editorPath!=='/api/v1/design/editor/')throw Error('entry');
        if(!abort.signal.aborted){setSource(entry.editorPath);setWaiting(false);}
      }catch{if(!abort.signal.aborted)setFailed(true);}
    };
    void observe();return()=>{abort.abort();clearTimeout(timer);command('disconnect');};
  },[identityId,attempt,command]);
  const connect=()=>{if(active&&status.target&&status.selectable&&!status.review){command('connect',{sessionID:active,expectedGeneration:status.generation});}};
  const review=status.review?.state==='uncertain'?status.review:null;
  const atOriginal=Boolean(review?.target&&status.target?.fileId===review.target.fileId&&status.target?.pageId===review.target.pageId);
  const [reviewTitle,reviewHelp,openOriginal,reviewed,noAccess]=penpotReviewCopy[locale];
  return <section className="plugin-workspace penpot-workspace" data-focus={Boolean(canvas)} aria-label={text('title')}
    onKeyDown={event=>{if(event.key==='Escape'){setPanel(null);setActions(false);}}}>
    <header className="penpot-toolbar">
      {canvas?<Button variant="quiet" className="penpot-tool-icon" onClick={()=>native.current?.back()}
        aria-label={backLabel} title={backLabel} disabled={!canvas.saved}><ArrowLeft size={18}/></Button>
        :<Button variant="quiet" onClick={onClose}><ArrowLeft size={18}/>{t('nav.home')}</Button>}
      <div className="penpot-file-meta">
        <h2 title={canvas?.name}>{canvas?.name||text('title')}</h2>
        {canvas?.saveText&&<span className="penpot-save-state" role="status" data-saved={canvas.saved}>{canvas.saveText}</span>}
      </div>
      {canvas&&<div className="penpot-canvas-panels">
        <Button variant="quiet" className="penpot-tool-icon" aria-label={layersLabel} title={layersLabel}
          aria-pressed={panel==='layers'} onClick={()=>{setActions(false);setShowAssistant(false);setPanel(value=>value==='layers'?null:'layers');}}><Layers size={18}/></Button>
        <Button variant="quiet" className="penpot-tool-icon" aria-label={propertiesLabel} title={propertiesLabel}
          aria-pressed={panel==='properties'} onClick={()=>{setActions(false);setShowAssistant(false);setPanel(value=>value==='properties'?null:'properties');}}><SlidersHorizontal size={18}/></Button>
      </div>}
      <Button variant="quiet" className="penpot-assistant-toggle" onClick={()=>{setPanel(null);setActions(false);setAssistantOpened(true);setShowAssistant(v=>!v);}}
        title={t('assistant.workspace.title')} aria-label={t('assistant.workspace.title')} aria-pressed={showAssistant}><MessageSquare size={18}/><span>{t('assistant.workspace.title')}</span></Button>
      {canvas&&<Button variant="quiet" className="penpot-tool-icon" aria-label={actionsLabel} title={actionsLabel}
        aria-expanded={actions} aria-controls="penpot-design-actions" onClick={()=>{setPanel(null);setActions(v=>!v);}}><Ellipsis size={19}/></Button>}
      <div id="penpot-design-actions" className="penpot-actions" data-open={actions}>
        <PenpotTeamSpaces key={identityId} frame={frame} locale={locale} t={t} ready={Boolean(source)&&editorLoaded}/>
        <PenpotTransfer frame={frame} identityId={identityId} locale={locale} t={t} ready={Boolean(source)}/>
        <span role="status" className="penpot-ai-state">{text(status.state)}</span>
      </div>
    </header>
    {review&&<div className="penpot-write-review" role="alert"><div><strong>{reviewTitle}</strong><p>{review.target?reviewHelp:noAccess}</p></div>
      {review.target&&<><Button variant="secondary" onClick={()=>command('open-review')} disabled={atOriginal}>{openOriginal}</Button>
        <Button variant="quiet" onClick={()=>command('reviewed')} disabled={!atOriginal}>{reviewed}</Button></>}
    </div>}
    <div className="penpot-panes" data-assistant={showAssistant} style={{'--design-assistant-width':`${width}px`} as CSSProperties}>
      <div className="penpot-editor-pane" tabIndex={0} aria-label={text('editor')} dir="ltr">
        {failed?<div role="alert" className="penpot-entry-state"><p>{t('applications.startup_failed')}</p><Button onClick={()=>setAttempt(v=>v+1)}><RefreshCw size={16}/>{t('applications.retry')}</Button></div>
          :<>
            {!presented&&<div role="status" className="penpot-entry-state">{t(waiting?'applications.startup_unavailable_detail':'applications.loading')}</div>}
            {source&&<iframe ref={frame} src={source} title={text('editor')} data-presented={presented}
              aria-hidden={!presented||undefined}
              onLoad={()=>{setPresented(false);setEditorGeneration(value=>value+1);command('status');}}
              sandbox="allow-downloads allow-forms allow-same-origin allow-scripts" allow="camera 'none'; microphone 'none'"/>}
          </>}
      </div>
      <aside className="penpot-assistant-pane" hidden={!showAssistant} aria-label={text('assistant')}>
        <div className="penpot-connection-controls">
          <p>{text(!status.target?'openFile':!active?'chooseSession':status.state==='connected'?'activeTarget':'connectHint')}</p>
          {status.reason&&<p role="status">{status.reason==='reopen'?penpotReopenCopy[locale]
            :text(status.reason==='upgrade_required'?'upgradePending':status.reason==='changed'?'changed':status.reason==='reconcile'?'uncertain':'reconnect')}</p>}
          <div><Button onClick={connect} disabled={!active||!status.target||!status.selectable||Boolean(status.review)||status.state!=='disconnected'}><Link2 size={16}/>{text('connect')}</Button>
            <Button variant="quiet" onClick={()=>command('disconnect')} disabled={status.state==='disconnected'}><Unlink size={16}/>{text('disconnect')}</Button>
            <Button variant="quiet" onClick={()=>command('status')} aria-label={text('refresh')}><RefreshCw size={16}/></Button></div>
          <label className="penpot-pane-size">{text('width')}<input type="range" min="340" max="700" step="20" value={width} onChange={event=>setWidth(Number(event.target.value))}/></label>
        </div>
        {assistantOpened&&<NativeAssistantWorkspace embedded identityId={identityId} locale={locale} t={t} onClose={()=>setShowAssistant(false)} onSessionChange={selectSession}/>}
      </aside>
    </div>
  </section>;
}

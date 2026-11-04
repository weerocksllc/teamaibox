import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {createPortal} from 'react-dom';
import {X,CircleStop,Settings2,RefreshCw} from 'lucide-react';
import {Button} from '@teamaibox/ui-system/components';
import type {Locale} from '../i18n';
import {EditorDialog} from '../EditorDialog';
import {createNativeClient,NativeApiError,nativeFilePart,type NativeSession,type NativeMessage,type NativePermission,type NativeQuestion,type NativeAgent,type NativeProviders as NativeProviderCatalog} from './native-client';
import './native-assistant.css';
import {nativeText} from './native-copy';
import {NativeWorkspaceTools} from './NativeWorkspaceTools';
import {NativeExtensions} from './NativeExtensions';
import {LegacyAssistantHistory} from './LegacyAssistantHistory';
import {NativeCustomization} from './NativeCustomization';
import {NativeContext} from './NativeContext';
import {nativeModelChoice} from './native-model';
import {visibleNativeMessages} from './native-history';
import {NativeChanges} from './NativeChanges';
import {NativeProviders} from './NativeProviders';
import {readNativeLocation,writeNativeLocation} from './native-location';
import {NativeProjects} from './NativeProjects';
import {nativeProjectText} from './native-project-copy';
import {isNativeWorkspace} from './native-workspace-path';
import {NativeRuntimeSettings} from './NativeRuntimeSettings';
import {NativeSessionTransfer} from './NativeSessionTransfer';
import {nativeTransferText} from './native-transfer-copy';
import {NativeToolCatalog} from './NativeToolCatalog';
import {NativeSessionShell} from './NativeSessionShell';
import {nativeShellText} from './native-shell-copy';
import {NativeMessageEditor} from './NativeMessageEditor';
import {NativeSessionIndex} from './NativeSessionIndex';
import {nativeSessionText} from './native-session-copy';
import {nativePendingMessages} from './native-pending';
import {AssistantBrowserState,attachmentFromFile,canonicalWorkspace,assistantAccountLocation} from './assistant-browser-state';
import {AssistantProjectNavigation,AssistantProjectHome,useAssistantProjects} from './AssistantProjectNavigation';
import {AssistantDesignIcon as Icon} from './AssistantDesignIcon';
import {projectSessionText,projectFeedbackText} from './project-session-copy';
import {AssistantFolderPicker} from './AssistantFolderPicker';

type Translator=(key:string,values?:Record<string,string|number>)=>string;
const segment=encodeURIComponent;
const pretty=(value:unknown)=>JSON.stringify(value,null,2);

export function NativeAssistantWorkspace({locale,identityId='',initialPrompt='',onClose,t}:{locale:Locale;identityId?:string;initialPrompt?:string;onClose:()=>void;t:Translator}) {
  const nt=(key:Parameters<typeof nativeText>[1])=>nativeText(locale,key);
  const pt=(key:Parameters<typeof projectSessionText>[1])=>projectSessionText(locale,key);
  const [client]=useState(createNativeClient);
  const [shellHeader]=useState(()=>document.querySelector<HTMLElement>('.app-frame .topbar'));
  const [browserState]=useState(()=>{let storage:Storage|null=null;try{storage=localStorage;if(identityId){const key='tab.assistant.activeIdentity';const next=assistantAccountLocation(new URL(location.href),sessionStorage.getItem(key),identityId);history.replaceState(null,'',next);sessionStorage.setItem(key,identityId);}}catch{}return new AssistantBrowserState(identityId,storage);});
  useSyncExternalStore(browserState.subscribe,browserState.snapshot,browserState.snapshot);
  const [directory,setDirectory]=useState(()=>readNativeLocation(new URL(location.href)).directory);
  const [sessions,setSessions]=useState<NativeSession[]>([]);
  const [active,setActive]=useState<string|null>(()=>readNativeLocation(new URL(location.href)).sessionId);
  const [messages,setMessages]=useState<NativeMessage[]>([]);
  const [selectedSession,setSelectedSession]=useState<NativeSession|null>(null);
  const [permissions,setPermissions]=useState<NativePermission[]>([]);
  const [questions,setQuestions]=useState<NativeQuestion[]>([]);
  const [status,setStatus]=useState<Record<string,{type:string}>>({});
  const [agents,setAgents]=useState<NativeAgent[]>([]);
  const [providers,setProviders]=useState<NativeProviderCatalog>({providers:[],default:{}});
  const draftContext={directory,sessionId:active};
  const currentDraft=browserState.get(draftContext);
  const {text:draft,agent,model,command}=currentDraft;
  const files=currentDraft.attachments.flatMap(a=>a.file?[a.file]:[]);
  const missingAttachments=currentDraft.attachments.some(a=>!a.file);
  const updateDraft=(patch:Parameters<AssistantBrowserState['update']>[1])=>browserState.update(draftContext,patch);
  const setDraft=(text:string)=>updateDraft({text});
  const setAgent=(agent:string)=>updateDraft({agent});const setModel=(model:string)=>updateDraft({model});const setCommand=(command:string)=>updateDraft({command});
  const [failed,setFailed]=useState<{text:string;files:File[];sessionId:string|null;directory:string;command:string;agent:string;model:string}[]>([]);
  const [busy,setBusy]=useState(false);const [connected,setConnected]=useState(false);
  const [error,setError]=useState('');const [settings,setSettings]=useState(false);
  const [config,setConfig]=useState('');const [saving,setSaving]=useState(false);
  const [configRevision,setConfigRevision]=useState(0);
  const [tools,setTools]=useState(false);
  const [toolsTab,setToolsTab]=useState<'files'|'terminal'>('files');
  const [home,setHome]=useState(()=>{const url=new URL(location.href);return url.searchParams.get('assistantView')==='home'||(!url.searchParams.has('assistantSession')&&!url.searchParams.has('assistantDirectory')&&url.searchParams.get('assistantView')!=='conversation'&&!initialPrompt);});
  const [navigationOpen,setNavigationOpen]=useState(false);
  const [narrow,setNarrow]=useState(()=>matchMedia('(max-width: 820px)').matches);
  const contextPanel=useRef<HTMLElement>(null);const contextOpener=useRef<HTMLElement|null>(null);
  const [folders,setFolders]=useState<'open'|'create'|null>(null);
  const [menu,setMenu]=useState(false);const menuRef=useRef<HTMLDetailsElement>(null);
  const [legacy,setLegacy]=useState(false);
  const [projectsOpen,setProjectsOpen]=useState(false);
  const [sessionIndexOpen,setSessionIndexOpen]=useState(false);
  const [transferOpen,setTransferOpen]=useState(false);
  const [shellOpen,setShellOpen]=useState(false);
  const [dialog,setDialog]=useState<'rename'|'delete'|'changes'|'context'|'skills'|null>(null);
  const [detail,setDetail]=useState<unknown>(null);const [title,setTitle]=useState('');
  const [commands,setCommands]=useState<{name:string;description?:string}[]>([]);
  const [todos,setTodos]=useState<{content:string;status:string;priority:string}[]>([]);
  const [children,setChildren]=useState<NativeSession[]>([]);
  const inflight=useRef(new Set<string>());const [acting,setActing]=useState<ReadonlySet<string>>(new Set());
  const selection=useRef(0);const refreshing=useRef<number|null>(null);const refreshAgain=useRef(false);
  const currentLocation=useRef({directory,active});currentLocation.current={directory,active};
  const report=useCallback((cause:unknown)=>{if(!client.signal.aborted&&!(cause instanceof Error&&cause.name==='AbortError'))setError(cause instanceof NativeApiError?t('assistant.workspace.error'):cause instanceof Error?cause.message:t('assistant.workspace.error'));},[client,t]);
  const refresh=useCallback(async()=>{
    if(currentLocation.current.directory!==directory||currentLocation.current.active!==active)return;
    const generation=selection.current;
    if(refreshing.current===generation){refreshAgain.current=true;return;}
    refreshing.current=generation;
    try{
      const [list,states,pending,asked,items,taskList,childList,current]=await Promise.all([
        client.request<NativeSession[]>('/session',{directory}),client.request<Record<string,{type:string}>>('/session/status',{directory}),
        client.request<NativePermission[]>('/permission',{directory}),client.request<NativeQuestion[]>('/question',{directory}),
        active?client.request<NativeMessage[]>(`/session/${segment(active)}/message`,{directory}):Promise.resolve([]),
        active?client.request<typeof todos>(`/session/${segment(active)}/todo`,{directory}):Promise.resolve([]),
        active?client.request<NativeSession[]>(`/session/${segment(active)}/children`,{directory}):Promise.resolve([]),
        active?client.request<NativeSession>(`/session/${segment(active)}`,{directory}):Promise.resolve(null),
      ]);
      if(generation!==selection.current||client.signal.aborted)return;
      setSessions(list);setStatus(states);setPermissions(pending);setQuestions(asked);setMessages(items);setTodos(taskList);setChildren(childList);
      setSelectedSession(current);
    }catch(cause){if(generation===selection.current){if(active&&cause instanceof NativeApiError&&cause.status===404){setActive(null);browserState.remember({directory,sessionId:null});history.replaceState(null,'',writeNativeLocation(new URL(location.href),null,directory));}else report(cause);}}finally{if(refreshing.current===generation)refreshing.current=null;}
  },[active,directory,client,report]);
  useEffect(()=>{client.activate();return()=>client.close();},[client]);
  useEffect(()=>{
    ++selection.current;setMessages([]);setSelectedSession(null);setPermissions([]);setQuestions([]);setTodos([]);setChildren([]);setDetail(null);setDialog(null);setError('');
    void refresh();
    // Events invalidate native views, not a second execution state machine.
    const timer=setInterval(()=>{if(refreshAgain.current){refreshAgain.current=false;void refresh();}},150);
    const close=client.events(directory,()=>{refreshAgain.current=true;},value=>{setConnected(value);if(value)refreshAgain.current=true;});
    return()=>{++selection.current;clearInterval(timer);close();};
  },[client,directory,refresh]);
  useEffect(()=>{let stale=false;void Promise.all([client.request<NativeAgent[]>('/agent',{directory}),client.request<NativeProviderCatalog>('/config/providers',{directory}),client.request<typeof commands>('/command',{directory})])
    .then(([a,p,c])=>{if(!stale&&!client.signal.aborted){setAgents(a);setProviders(p);setCommands(c);}}).catch(report);return()=>{stale=true;};},[client,directory,report,configRevision,settings]);
  const catalog=useAssistantProjects(client,sessions,browserState,report);
  useEffect(()=>{browserState.remember({directory,sessionId:active});},[browserState,directory,active]);
  useEffect(()=>{const query=matchMedia('(max-width: 820px)');const change=()=>setNarrow(query.matches);query.addEventListener('change',change);return()=>query.removeEventListener('change',change);},[]);
  useEffect(()=>{if(tools){contextOpener.current=document.activeElement as HTMLElement;contextPanel.current?.focus();}else if(contextOpener.current?.isConnected){contextOpener.current.focus();contextOpener.current=null;}},[tools,toolsTab]);
  useEffect(()=>{if(!tools)return;const escape=(event:KeyboardEvent)=>{
    if(event.key!=='Escape'||document.querySelector('dialog[open]')||menuRef.current?.open||(event.target as Element)?.closest?.('.profile-popover,.popover'))return;
    // A panel owns Escape even while a disabled control has temporarily moved
    // focus to body. Prevent the product shell from closing the whole app.
    event.preventDefault();setTools(false);
  };window.addEventListener('keydown',escape,true);return()=>window.removeEventListener('keydown',escape,true);},[tools]);
  useEffect(()=>{if(initialPrompt&&!currentDraft.text)browserState.update(draftContext,{text:initialPrompt});},[browserState]);
  const select=(id:string|null,nextDirectory=directory)=>{const canonical=canonicalWorkspace(nextDirectory);if(!canonical)return;++selection.current;currentLocation.current={directory:canonical,active:id};setDirectory(canonical);setActive(id);setHome(false);setNavigationOpen(false);setMenu(false);browserState.remember({directory:canonical,sessionId:id});const next=writeNativeLocation(new URL(location.href),id,canonical);next.searchParams.set('assistantView','conversation');history.replaceState(null,'',next);};
  const openWorkspace=(path:string)=>{
    if(!isNativeWorkspace(path)){setError(nativeProjectText(locale,'invalidWorkspace'));return;}
    select(browserState.recent().find(r=>r.directory===path)?.sessionId??null,path);setProjectsOpen(false);setFolders(null);
  };
  const mutate=async(path:string,body:unknown={})=>{
    if(inflight.current.has(path))return;
    inflight.current.add(path);setActing(new Set(inflight.current));
    try{setError('');await client.request(path,{method:'POST',body,directory});await refresh();}catch(cause){report(cause);}
    finally{inflight.current.delete(path);if(!client.signal.aborted)setActing(new Set(inflight.current));}
  };
  const fork=async(messageID?:string)=>{if(!active)return;const generation=selection.current;try{const item=await client.request<NativeSession>(`/session/${segment(active)}/fork`,{method:'POST',body:{messageID},directory});if(generation===selection.current&&!client.signal.aborted)select(item.id);}catch(cause){if(generation===selection.current)report(cause);}};
  const openDetail=async(kind:'changes'|'context'|'skills')=>{
    if(kind!=='skills'&&!active)return;setDialog(kind);setDetail(null);
    const generation=selection.current;
    try{const value=await client.request(kind==='skills'?'/skill':`/session/${segment(active!)}/message`,{directory});if(generation===selection.current&&!client.signal.aborted)setDetail(value);}catch(cause){report(cause);}
  };
  const editSession=async()=>{
    if(!active)return;setSaving(true);
    const target={directory,sessionId:active};const generation=selection.current;
    try{await client.request(`/session/${segment(active)}`,{method:dialog==='delete'?'DELETE':'PATCH',...(dialog==='delete'?{}:{body:{title}}),directory});if(dialog==='delete'){browserState.remove(target);setFailed(items=>items.filter(i=>i.directory!==target.directory||i.sessionId!==target.sessionId));if(generation===selection.current){setSessions(items=>items.filter(item=>item.id!==active));select(null);}}else if(generation===selection.current)await refresh();if(generation===selection.current||dialog==='delete')setDialog(null);}catch(cause){report(cause);}finally{setSaving(false);}
  };
  const compact=async()=>{
    if(!active)return;
    try{
      const effective=await client.request<{model?:string}>('/config',{directory});
      await mutate(`/session/${segment(active)}/summarize`,nativeModelChoice(model,effective.model));
    }catch(cause){report(cause);}
  };
  const archive=async()=>{
    if(!active)return;const generation=selection.current;
    try{await client.request(`/session/${segment(active)}`,{method:'PATCH',directory,body:{time:{archived:selectedSession?.time.archived?0:Date.now()}}});if(generation===selection.current)await refresh();}
    catch(cause){report(cause);}
  };
  const send=async(event:React.FormEvent)=>{
    event.preventDefault();if(busy||missingAttachments||(!draft.trim()&&!files.length&&!command))return;
    const generation=selection.current;
    const submitted={text:draft,files,sessionId:active,directory,command,agent,model};updateDraft({text:'',attachments:[]});setBusy(true);setError('');
    try{
      const id=active??(await client.request<NativeSession>('/session',{method:'POST',body:{},directory})).id;
      submitted.sessionId=id;
      if(!active&&selection.current===generation){browserState.move({directory,sessionId:null},{directory,sessionId:id});select(id);}
      const attachments=await Promise.all(submitted.files.map(nativeFilePart));
      const [providerID,modelID]=model.split('\n');
      const messageID=`msg_${crypto.randomUUID().replaceAll('-','')}`;
      if(command)await client.request(`/session/${segment(id)}/command`,{method:'POST',directory,body:{command,arguments:submitted.text,messageID,parts:attachments,...(agent?{agent}:{}),...(model?{model:`${providerID}/${modelID}`}:{})}});
      else await client.request(`/session/${segment(id)}/prompt_async`,{method:'POST',directory,body:{
        messageID,
        parts:[...(submitted.text?[{type:'text',text:submitted.text}]:[]),...attachments],
        ...(agent?{agent}:{}),...(model?{model:{providerID,modelID}}:{}),
      }});
      refreshAgain.current=true;
    }catch(cause){if(!client.signal.aborted){setFailed(items=>[...items,submitted]);report(cause);}}
    finally{if(!client.signal.aborted)setBusy(false);}
  };
  const openSettings=async()=>{setSettings(true);try{setConfig(pretty(await client.request('/global/config')));}catch(cause){report(cause);}};
  const saveSettings=async()=>{setSaving(true);try{await client.request('/global/config',{method:'PATCH',body:JSON.parse(config)});setConfigRevision(value=>value+1);setSettings(false);setConfig('');await refresh();}catch(cause){report(cause);}finally{setSaving(false);}};
  const shownMessages=visibleNativeMessages(messages,selectedSession?.revert);
  const pendingMessages=nativePendingMessages(shownMessages);
  const running=Boolean(active&&status[active]&&status[active].type!=='idle');
  const waiting=permissions.some(p=>p.sessionID===active)||questions.some(q=>q.sessionID===active);
  const lastAssistantError=[...messages].reverse().find(m=>m.info.role==='assistant')?.info.error;
  const stopped=Boolean(lastAssistantError&&typeof lastAssistantError==='object'&&(lastAssistantError as {name?:string}).name==='MessageAbortedError');
  const navigation=<AssistantProjectNavigation directory={directory} active={active} {...catalog} locale={locale} state={browserState} newConversationLabel={t('assistant.workspace.new_conversation')} onSelect={item=>select(item.sessionId,item.directory)} onHome={()=>{setHome(true);setNavigationOpen(false);const next=new URL(location.href);next.searchParams.set('assistantView','home');history.replaceState(null,'',next);}} onNew={()=>{setNavigationOpen(false);setFolders('create');}} onFolder={()=>{setNavigationOpen(false);setFolders('open');}} onSearch={()=>{setNavigationOpen(false);setSessionIndexOpen(true);}} onSettings={()=>{setNavigationOpen(false);setProjectsOpen(true);}} onClose={()=>setNavigationOpen(false)}/>;
  const workspacePanel=tools&&<section ref={contextPanel} tabIndex={-1} aria-label={nt(toolsTab)} className={toolsTab==='terminal'?'assistant-terminal-drawer':'assistant-context-panel'}><header><strong>{nt(toolsTab)}</strong><Button variant="quiet" aria-label={t('common.close')} onClick={()=>setTools(false)}><Icon name="close"/></Button></header><NativeWorkspaceTools key={directory} client={client} directory={directory} locale={locale} onError={report} initialTab={toolsTab} onTabChange={setToolsTab}/></section>;
  const header=<div className="assistant-workspace__header assistant-native-header">
      <Button variant="quiet" className="assistant-navigation-toggle" aria-label={pt('navigation')} aria-expanded={navigationOpen} onClick={()=>setNavigationOpen(v=>!v)}><Icon name="folder"/></Button>
      <div><h2 id="native-assistant-title">{t('assistant.workspace.title')}</h2></div>
      <Button className="assistant-header-search" variant="quiet" onClick={()=>setSessionIndexOpen(true)}><Icon name="search"/>{nativeSessionText(locale,'browse')}</Button>
      <span className="assistant-connection" data-connected={connected}><i/>{connected?projectFeedbackText(locale,'connected'):t('assistant.workspace.reconnecting')}</span>
      <button type="button" className="icon-button" onClick={()=>void openSettings()} aria-label={nt('settings')}><Settings2 size={18}/></button>
      <button type="button" className="icon-button" onClick={onClose} aria-label={t('app.close')}><X size={20}/></button>
    </div>;
  return <section className={`assistant-workspace assistant-native ${shellHeader?'assistant-native--shell-header':''}`} role="region" aria-labelledby="native-assistant-title" onKeyDown={event=>{if(event.key==='Escape'&&tools){event.stopPropagation();setTools(false);}}}>
    {shellHeader?createPortal(header,shellHeader):header}
    <div className={`assistant-workspace__body ${navigationOpen?'is-navigation-open':''}`}>
      {!(narrow&&navigationOpen)&&navigation}
      <div className="assistant-home-container" hidden={!home}><AssistantProjectHome {...catalog} lastSelections={browserState.recent()} locale={locale} onOpen={item=>select(item.sessionId,item.directory)} onFolder={()=>setFolders('open')} onNew={()=>setFolders('create')} onSearch={()=>setSessionIndexOpen(true)}/></div>
      <div className={`assistant-chat-layout ${tools?'has-context':''}`} hidden={home}><main className="assistant-conversation-main">
      <div className="assistant-session-heading"><div><small dir="ltr">{directory}</small><h3>{selectedSession?.title||t('assistant.workspace.new_conversation')}</h3></div>
        {(waiting||running||stopped)&&<span className="assistant-run-status" role="status">{projectFeedbackText(locale,waiting?'waiting':running?'running':'stopped')}</span>}
        <Button variant="quiet" aria-label={nt('files')} aria-pressed={tools} onClick={()=>setTools(v=>!v)}><Icon name="folder"/></Button>
        <Button variant="quiet" aria-label={nt('terminal')} onClick={()=>{setTools(true);setToolsTab('terminal');}}><Icon name="command"/></Button>
        <details ref={menuRef} className="assistant-more-menu" open={menu} onToggle={e=>setMenu(e.currentTarget.open)} onKeyDown={e=>{if(e.key==='Escape'){setMenu(false);menuRef.current?.querySelector('summary')?.focus();e.stopPropagation();}}}><summary aria-label={pt('more')}><Icon name="more"/></summary><nav className="native-actions native-session-toolbar" aria-label={pt('more')} onClick={e=>{if((e.target as Element).closest('button'))setMenu(false);}}>
        {active&&<Button variant="quiet" onClick={()=>{setError('');setShellOpen(true);}}>{nativeShellText(locale,'title')}</Button>}
        <Button variant="quiet" onClick={()=>setTransferOpen(true)}>{nativeTransferText(locale,'transfer')}</Button>
        {selectedSession?.parentID&&<Button variant="quiet" onClick={()=>select(selectedSession.parentID!)}>{nt('parent')}</Button>}
        <Button variant="quiet" onClick={()=>{setTools(true);setToolsTab('files');}}>{nt('files')} / {nt('terminal')}</Button><Button variant="quiet" onClick={()=>void openDetail('skills')}>{nt('skills')}</Button>
        <Button variant="quiet" onClick={()=>setLegacy(true)}>{nt('legacyHistory')}</Button>
        <Button variant="quiet" onClick={()=>setProjectsOpen(true)}>{pt('projectSettings')}</Button>
        {active&&<Button variant="quiet" onClick={()=>void archive()}>{pt(selectedSession?.time.archived?'unarchive':'archive')}</Button>}
        {active&&<><Button variant="quiet" onClick={()=>{setTitle(sessions.find(s=>s.id===active)?.title??'');setDialog('rename');}}>{nt('rename')}</Button><Button variant="quiet" onClick={()=>void fork()}>{nt('fork')}</Button><Button variant="quiet" onClick={()=>void openDetail('changes')}>{nt('changes')}</Button><Button variant="quiet" onClick={()=>void openDetail('context')}>{nt('context')}</Button><Button variant="quiet" disabled={!model&&!Object.keys(providers.default).length} onClick={()=>void compact()}>{nt('compact')}</Button><Button variant="quiet" onClick={()=>void mutate(`/session/${segment(active)}/unrevert`)}>{nt('redo')}</Button><Button variant="quiet" onClick={()=>setDialog('delete')}>{nt('delete')}</Button></>}
      </nav></details></div>
      {error&&<div className="assistant-error" role="alert"><span>{error}</span><button type="button" onClick={()=>void refresh()} aria-label={t('assistant.workspace.retry')}><RefreshCw size={16}/></button></div>}
      <div className="assistant-transcript" aria-live="polite">
        {!shownMessages.length&&<div className="assistant-empty"><Icon name="spark"/><h3>{t('assistant.workspace.empty_title')}</h3><p>{t('assistant.workspace.empty_body')}</p></div>}
        {shownMessages.map(message=><article key={message.info.id} className={`assistant-message assistant-message--${message.info.role}`}><div className="assistant-message__body">
          <header>{message.info.role==='assistant'&&<Icon name="spark"/>}<strong>{t(message.info.role==='user'?'assistant.workspace.you':'assistant.workspace.assistant')}</strong><time>{new Intl.DateTimeFormat(locale,{timeStyle:'short'}).format(message.info.time.created)}</time></header>
          {pendingMessages.has(message.info.id)&&<span className="native-pending" data-native-pending={message.info.id}>{nativeSessionText(locale,'queued')}</span>}
          {message.parts.map(part=>['step-start','step-finish','snapshot'].includes(part.type)?null:part.type==='text'?<div key={part.id} className="assistant-message__content">{part.text}</div>:
            <details key={part.id} className="native-part"><summary>{part.state?.status==='completed'?<Icon name="check"/>:part.filename?<Icon name="file"/>:null}{part.state?.title??part.tool??part.filename??part.type}{part.state?` · ${part.state.status}`:''}</summary><pre>{part.state?pretty(part.state):pretty(part)}</pre></details>)}
          {message.info.tokens&&<footer>{t('assistant.workspace.usage',{input:message.info.tokens.input,output:message.info.tokens.output})}</footer>}
          {message.info.error!=null&&<pre role="alert">{pretty(message.info.error)}</pre>}
          <details className="assistant-message-options"><summary aria-label={pt('more')}><Icon name="more"/></summary><NativeMessageEditor client={client} directory={directory} message={message} running={Boolean(active&&status[active]&&status[active].type!=='idle')} locale={locale} onError={report} onSaved={()=>{setError('');void refresh();}}/>
          {message.parts.some(p=>['step-start','step-finish','snapshot'].includes(p.type))&&<details className="native-part"><summary>{nt('context')}</summary><pre>{pretty(message.parts.filter(p=>['step-start','step-finish','snapshot'].includes(p.type)))}</pre></details>}
          {message.info.role==='user'&&<div className="native-message-actions"><Button variant="quiet" onClick={()=>void fork(message.info.id)}>{nt('fork')}</Button><Button variant="quiet" disabled={Boolean(active&&status[active]&&status[active].type!=='idle')} onClick={()=>void mutate(`/session/${segment(active!)}/revert`,{messageID:message.info.id})}>{nt('undo')}</Button></div>}</details>
        </div></article>)}
        {!!todos.length&&<details className="native-part"><summary>{nt('tasks')}</summary><ul>{todos.map((item,i)=><li key={i}>{item.content} · {item.status} · {item.priority}</li>)}</ul></details>}
        {!!children.length&&<details className="native-part"><summary>{nt('children')}</summary>{children.map(child=><Button key={child.id} variant="secondary" onClick={()=>select(child.id)}>{child.title}</Button>)}</details>}
        {permissions.filter(p=>p.sessionID===active).map(p=><article key={p.id} className="assistant-confirmation"><strong>{p.permission}</strong><pre>{pretty({patterns:p.patterns,...p.metadata})}</pre>
          <div className="native-actions">{(['once','always','reject'] as const).map(reply=><Button key={reply} disabled={acting.has(`/permission/${segment(p.id)}/reply`)} variant="secondary" onClick={()=>void mutate(`/permission/${segment(p.id)}/reply`,{reply})}>{nt(reply)}</Button>)}</div></article>)}
        {questions.filter(q=>q.sessionID===active).map(q=><NativeQuestionForm key={q.id} question={q} t={t} onReply={answers=>mutate(`/question/${segment(q.id)}/reply`,{answers})} onReject={()=>mutate(`/question/${segment(q.id)}/reject`)}/>)}
        {failed.map((item,index)=><div key={index} className="assistant-error"><span>{nt('uncertain')}</span><code dir="ltr">{item.directory}</code><pre>{item.text}</pre><span>{item.files.map(f=>f.name).join(', ')}</span><Button variant="secondary" disabled={Boolean(browserState.get({directory:item.directory,sessionId:item.sessionId}).text||browserState.get({directory:item.directory,sessionId:item.sessionId}).attachments.length)} onClick={()=>{browserState.update({directory:item.directory,sessionId:item.sessionId},{text:item.text,attachments:item.files.map(attachmentFromFile),command:item.command,agent:item.agent,model:item.model});select(item.sessionId,item.directory);setFailed(items=>items.filter((_,i)=>i!==index));}}>{nt('restore')}</Button></div>)}
      </div>
      {toolsTab==='terminal'&&workspacePanel}
      <form className="assistant-workspace__composer" onSubmit={send}><div className="assistant-compose-surface">
        {browserState.notice&&<p role="status">{pt(browserState.notice==='conflict'?'storageConflict':'storageUnavailable')}</p>}
        <textarea className="assistant-compose-input" aria-label={t('assistant.workspace.composer_label')} value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}}} rows={2} placeholder={t('assistant.workspace.composer_placeholder')}/>
        <div className="assistant-compose-row"><label className="assistant-attach"><Icon name="paperclip"/><input type="file" multiple aria-label={t('assistant.workspace.attach')} onChange={e=>{const selected=Array.from(e.target.files??[]);updateDraft({attachments:[...currentDraft.attachments.filter(a=>a.file||!selected.some(f=>f.name===a.name&&f.size===a.size)),...selected.map(attachmentFromFile)]});e.target.value='';}}/></label>
          <select aria-label={nt('agent')} value={agent} onChange={e=>setAgent(e.target.value)}><option value="">{nt('agent')}</option>{agents.filter(a=>!a.hidden&&a.mode!=='subagent').map(a=><option key={a.name} value={a.name}>{a.name}</option>)}</select>
          <select aria-label={nt('model')} value={model} onChange={e=>setModel(e.target.value)}><option value="">{nt('model')}</option>{providers.providers.flatMap(p=>Object.values(p.models).map(m=><option key={`${p.id}/${m.id}`} value={`${p.id}\n${m.id}`}>{p.name} · {m.name}</option>))}</select>
          <select aria-label={nt('command')} value={command} onChange={e=>setCommand(e.target.value)}><option value="">{nt('command')}</option>{commands.map(item=><option key={item.name} value={item.name} title={item.description}>/{item.name}</option>)}</select>
          {active&&status[active]&&status[active].type!=='idle'&&<button type="button" className="assistant-stop" aria-label={t('assistant.workspace.stop')} onClick={()=>void mutate(`/session/${segment(active)}/abort`)}><CircleStop size={18}/></button>}
          {draft&&!browserState.notice&&identityId&&<small className="assistant-draft-status">{pt('draftSaved')}</small>}
          <Button type="submit" variant="primary" disabled={busy||missingAttachments||(!draft.trim()&&!files.length&&!command)} aria-label={t('assistant.send')}><Icon name="send"/></Button>
        </div>{currentDraft.attachments.map((attachment,i)=><div className="assistant-attachment" key={i}>{attachment.name}{!attachment.file&&<span role="status"> · {pt('reselect')}</span>}<button type="button" onClick={()=>updateDraft({attachments:currentDraft.attachments.filter((_,j)=>i!==j)})} aria-label={t('assistant.workspace.remove_attachment')}><X size={12}/></button></div>)}
      </div></form>
    </main>{toolsTab==='files'&&workspacePanel}</div></div>
    {narrow&&navigationOpen&&<EditorDialog title={pt('navigation')} closeLabel={t('common.close')} busy={false} onCancel={()=>setNavigationOpen(false)}>{navigation}</EditorDialog>}
    {folders&&<AssistantFolderPicker client={client} directory={directory} locale={locale} mode={folders} onOpen={openWorkspace} onCancel={()=>setFolders(null)} t={t}/>}
    {projectsOpen&&<EditorDialog title={nativeProjectText(locale,'projects')} closeLabel={t('common.close')} busy={false} onCancel={()=>setProjectsOpen(false)} feedback={error}><NativeProjects key={directory} client={client} directory={directory} locale={locale} onOpen={openWorkspace} onError={report}/></EditorDialog>}
    {sessionIndexOpen&&<EditorDialog title={nativeSessionText(locale,'browse')} closeLabel={t('common.close')} busy={false} onCancel={()=>setSessionIndexOpen(false)} feedback={error}><NativeSessionIndex client={client} directory={directory} locale={locale} onError={report} onOpen={item=>{select(item.id,item.directory);setSessionIndexOpen(false);}}/></EditorDialog>}
    {shellOpen&&active&&<EditorDialog title={nativeShellText(locale,'title')} closeLabel={t('common.close')} busy={false} onCancel={()=>setShellOpen(false)} feedback={error}><NativeSessionShell key={`${directory}:${active}`} client={client} directory={directory} sessionId={active} locale={locale} agent={agent} model={model} running={Boolean(status[active]&&status[active].type!=='idle')} onError={report} onResult={()=>{setError('');void refresh();}}/></EditorDialog>}
    {transferOpen&&<EditorDialog title={nativeTransferText(locale,'transfer')} closeLabel={t('common.close')} busy={false} onCancel={()=>setTransferOpen(false)} feedback={error}><NativeSessionTransfer key={directory} client={client} directory={directory} sessionId={active} running={Boolean(active&&status[active]&&status[active].type!=='idle')} locale={locale} onError={report} onImported={session=>{setTransferOpen(false);select(session.id);}}/></EditorDialog>}
    {legacy&&<EditorDialog title={nt('legacyHistory')} closeLabel={t('common.close')} busy={false} onCancel={()=>setLegacy(false)} feedback={error}><LegacyAssistantHistory locale={locale} onError={report} onResume={session=>{
      void client.request<NativeSession>(`/session/${segment(session.id)}`,{directory:session.directory}).then(value=>{
        if(client.signal.aborted)return;select(value.id,session.directory);setLegacy(false);
      }).catch(report);
    }}/></EditorDialog>}
    {dialog&&<EditorDialog title={nt(dialog)} closeLabel={t('common.close')} busy={saving} onCancel={()=>{setDialog(null);setDetail(null);}} feedback={error}>
      {dialog==='context'&&Array.isArray(detail)&&<NativeContext messages={detail as NativeMessage[]} locale={locale} t={t}/>}
      {dialog==='changes'&&active&&Array.isArray(detail)&&<NativeChanges client={client} sessionId={active} directory={directory} messages={detail as NativeMessage[]} locale={locale} onError={report}/>}
      {dialog==='rename'||dialog==='delete'?<form onSubmit={e=>{e.preventDefault();void editSession();}}>{dialog==='rename'?<input aria-label={nt('rename')} value={title} onChange={e=>setTitle(e.target.value)} required/>:<><p>{nt('deleteConfirm')}</p><strong>{selectedSession?.title}</strong><p>{pt('filesKept')}</p></>}<Button variant="primary" disabled={saving} type="submit">{dialog==='delete'?nt('delete'):nt('save')}</Button></form>:dialog==='skills'&&Array.isArray(detail)?<div className="native-skill-list">{(detail as {name:string;description?:string;location:string;content:string}[]).map(skill=><article key={skill.name}><h3>{skill.name}</h3><p>{skill.description}</p><code>{skill.location}</code><details><summary>{nt('context')}</summary><pre className="native-detail">{skill.content}</pre></details><Button variant="secondary" disabled={!commands.some(item=>item.name===skill.name)} onClick={()=>{setCommand(skill.name);setDialog(null);}}>{nt('command')} /{skill.name}</Button></article>)}</div>:(dialog==='context'||dialog==='changes')&&detail!==null?null:<pre className="native-detail">{detail===null?'…':pretty(detail)}</pre>}
    </EditorDialog>}
    {settings&&<EditorDialog title={nt('settings')} closeLabel={t('common.close')} busy={saving} onCancel={()=>{setSettings(false);setConfig('');}} feedback={error}>
      <NativeExtensions client={client} directory={directory} locale={locale} onError={report}/>
      <NativeProviders client={client} directory={directory} locale={locale} onError={report} onSaved={()=>setConfigRevision(value=>value+1)}/>
      <NativeCustomization client={client} locale={locale} onError={report} onSaved={()=>setConfigRevision(value=>value+1)}/>
      <NativeRuntimeSettings key={directory} client={client} directory={directory} locale={locale} onError={report} onReload={()=>{setError('');setConfigRevision(value=>value+1);}}/>
      <NativeToolCatalog key={`${directory}:${configRevision}`} client={client} directory={directory} locale={locale} selection={model} onError={report}/>
      <details onToggle={e=>{if(e.currentTarget.open)void client.request('/global/config').then(value=>setConfig(pretty(value))).catch(report);}}><summary>{nt('settings')} · JSON</summary><textarea className="native-config-editor" aria-label={nt('settings')} value={config} onChange={e=>setConfig(e.target.value)} spellCheck={false} rows={18}/><div className="native-actions"><Button variant="primary" disabled={saving} onClick={()=>void saveSettings()}>{nt('save')}</Button></div></details>
    </EditorDialog>}
  </section>;
}

function NativeQuestionForm({question,t,onReply,onReject}:{question:NativeQuestion;t:Translator;onReply:(answers:string[][])=>Promise<void>;onReject:()=>Promise<void>}) {
  const [answers,setAnswers]=useState<string[][]>(()=>question.questions.map(()=>[]));const [busy,setBusy]=useState(false);
  return <form className="assistant-confirmation" onSubmit={e=>{e.preventDefault();setBusy(true);void onReply(answers).finally(()=>setBusy(false));}}>
    {question.questions.map((q,i)=><fieldset key={i}><legend>{q.header}: {q.question}</legend>{q.options.map(o=><label key={o.label}><input type={q.multiple?'checkbox':'radio'} name={`${question.id}-${i}`} checked={answers[i].includes(o.label)} onChange={e=>setAnswers(items=>items.map((v,j)=>j!==i?v:q.multiple?(e.target.checked?[...v,o.label]:v.filter(x=>x!==o.label)):[o.label]))}/><strong>{o.label}</strong> {o.description}</label>)}{q.custom!==false&&<input aria-label={q.question} placeholder={t('assistant.workspace.composer_placeholder')} onChange={e=>setAnswers(items=>items.map((v,j)=>j===i?[e.target.value]:v))}/>}</fieldset>)}
    <div className="native-actions"><Button type="button" variant="secondary" disabled={busy} onClick={()=>void onReject()}>{t('common.cancel')}</Button><Button type="submit" variant="primary" disabled={busy||answers.some(v=>!v.length)}>{t('assistant.send')}</Button></div>
  </form>;
}

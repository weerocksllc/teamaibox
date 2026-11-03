import {useCallback,useEffect,useRef,useState} from 'react';
import {Bot,Plus,X,SendHorizontal,CircleStop,Paperclip,Settings2,RefreshCw} from 'lucide-react';
import {Button} from '@teamaibox/ui-system/components';
import type {Locale} from '../i18n';
import {EditorDialog} from '../EditorDialog';
import {createNativeClient,nativeFilePart,type NativeSession,type NativeMessage,type NativePermission,type NativeQuestion,type NativeAgent,type NativeProviders as NativeProviderCatalog} from './native-client';
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

type Translator=(key:string,values?:Record<string,string|number>)=>string;
const segment=encodeURIComponent;
const pretty=(value:unknown)=>JSON.stringify(value,null,2);

export function NativeAssistantWorkspace({locale,initialPrompt='',onClose,t}:{locale:Locale;initialPrompt?:string;onClose:()=>void;t:Translator}) {
  const nt=(key:Parameters<typeof nativeText>[1])=>nativeText(locale,key);
  const [client]=useState(createNativeClient);
  const [directory,setDirectory]=useState(()=>readNativeLocation(new URL(location.href)).directory);
  const [directoryDraft,setDirectoryDraft]=useState(directory);
  const [sessions,setSessions]=useState<NativeSession[]>([]);
  const [active,setActive]=useState<string|null>(()=>readNativeLocation(new URL(location.href)).sessionId);
  const [messages,setMessages]=useState<NativeMessage[]>([]);
  const [selectedSession,setSelectedSession]=useState<NativeSession|null>(null);
  const [permissions,setPermissions]=useState<NativePermission[]>([]);
  const [questions,setQuestions]=useState<NativeQuestion[]>([]);
  const [status,setStatus]=useState<Record<string,{type:string}>>({});
  const [agents,setAgents]=useState<NativeAgent[]>([]);
  const [providers,setProviders]=useState<NativeProviderCatalog>({providers:[],default:{}});
  const [agent,setAgent]=useState('');const [model,setModel]=useState('');
  const [draft,setDraft]=useState(initialPrompt);const [files,setFiles]=useState<File[]>([]);
  const [failed,setFailed]=useState<{text:string;files:File[];sessionId:string|null;directory:string;command:string;agent:string;model:string}[]>([]);
  const [busy,setBusy]=useState(false);const [connected,setConnected]=useState(false);
  const [error,setError]=useState('');const [settings,setSettings]=useState(false);
  const [config,setConfig]=useState('');const [saving,setSaving]=useState(false);
  const [configRevision,setConfigRevision]=useState(0);
  const [tools,setTools]=useState(false);
  const [legacy,setLegacy]=useState(false);
  const [projectsOpen,setProjectsOpen]=useState(false);
  const [sessionIndexOpen,setSessionIndexOpen]=useState(false);
  const [transferOpen,setTransferOpen]=useState(false);
  const [shellOpen,setShellOpen]=useState(false);
  const [dialog,setDialog]=useState<'rename'|'delete'|'changes'|'context'|'skills'|null>(null);
  const [detail,setDetail]=useState<unknown>(null);const [title,setTitle]=useState('');
  const [commands,setCommands]=useState<{name:string;description?:string}[]>([]);
  const [command,setCommand]=useState('');
  const [todos,setTodos]=useState<{content:string;status:string;priority:string}[]>([]);
  const [children,setChildren]=useState<NativeSession[]>([]);
  const inflight=useRef(new Set<string>());const [acting,setActing]=useState<ReadonlySet<string>>(new Set());
  const selection=useRef(0);const refreshing=useRef(false);const refreshAgain=useRef(false);
  const report=useCallback((cause:unknown)=>{if(!client.signal.aborted&&!(cause instanceof Error&&cause.name==='AbortError'))setError(cause instanceof Error?cause.message:t('assistant.workspace.error'));},[client,t]);
  const refresh=useCallback(async()=>{
    if(refreshing.current){refreshAgain.current=true;return;}
    refreshing.current=true;const generation=selection.current;
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
    }catch(cause){if(generation===selection.current)report(cause);}finally{refreshing.current=false;}
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
  const select=(id:string|null,nextDirectory=directory)=>{++selection.current;setActive(id);history.replaceState(null,'',writeNativeLocation(new URL(location.href),id,nextDirectory));};
  const openWorkspace=(path:string)=>{
    if(!isNativeWorkspace(path)){setError(nativeProjectText(locale,'invalidWorkspace'));return;}
    setDirectory(path);setDirectoryDraft(path);select(null,path);setProjectsOpen(false);
  };
  const mutate=async(path:string,body:unknown={})=>{
    if(inflight.current.has(path))return;
    inflight.current.add(path);setActing(new Set(inflight.current));
    try{setError('');await client.request(path,{method:'POST',body,directory});await refresh();}catch(cause){report(cause);}
    finally{inflight.current.delete(path);if(!client.signal.aborted)setActing(new Set(inflight.current));}
  };
  const create=async()=>{try{const item=await client.request<NativeSession>('/session',{method:'POST',body:{},directory});select(item.id);}catch(cause){report(cause);}};
  const fork=async(messageID?:string)=>{if(!active)return;try{const item=await client.request<NativeSession>(`/session/${segment(active)}/fork`,{method:'POST',body:{messageID},directory});select(item.id);}catch(cause){report(cause);}};
  const openDetail=async(kind:'changes'|'context'|'skills')=>{
    if(kind!=='skills'&&!active)return;setDialog(kind);setDetail(null);
    const generation=selection.current;
    try{const value=await client.request(kind==='skills'?'/skill':`/session/${segment(active!)}/message`,{directory});if(generation===selection.current&&!client.signal.aborted)setDetail(value);}catch(cause){report(cause);}
  };
  const editSession=async()=>{
    if(!active)return;setSaving(true);
    try{await client.request(`/session/${segment(active)}`,{method:dialog==='delete'?'DELETE':'PATCH',...(dialog==='delete'?{}:{body:{title}}),directory});if(dialog==='delete'){setSessions(items=>items.filter(item=>item.id!==active));select(null);}else await refresh();setDialog(null);}catch(cause){report(cause);}finally{setSaving(false);}
  };
  const compact=async()=>{
    if(!active)return;
    try{
      const effective=await client.request<{model?:string}>('/config',{directory});
      await mutate(`/session/${segment(active)}/summarize`,nativeModelChoice(model,effective.model));
    }catch(cause){report(cause);}
  };
  const send=async(event:React.FormEvent)=>{
    event.preventDefault();if(busy||(!draft.trim()&&!files.length&&!command))return;
    const generation=selection.current;
    const submitted={text:draft,files,sessionId:active,directory,command,agent,model};setDraft('');setFiles([]);setBusy(true);setError('');
    try{
      const id=active??(await client.request<NativeSession>('/session',{method:'POST',body:{},directory})).id;
      submitted.sessionId=id;
      if(!active&&selection.current===generation)select(id);
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
  return <section className="assistant-workspace assistant-native" role="region" aria-labelledby="native-assistant-title">
    <header className="assistant-workspace__header"><span className="assistant-workspace__brand"><Bot size={19}/></span>
      <div><p>{t('assistant.workspace.eyebrow')}</p><h2 id="native-assistant-title">{sessions.find(s=>s.id===active)?.title||t('assistant.workspace.title')}</h2></div>
      <span className="assistant-connection"><i/>{t(`assistant.workspace.${connected?'connected':'reconnecting'}`)}</span>
      <button type="button" className="icon-button" onClick={()=>void openSettings()} aria-label={nt('settings')}><Settings2 size={18}/></button>
      <button type="button" className="icon-button" onClick={onClose} aria-label={t('app.close')}><X size={20}/></button>
    </header>
    <div className="assistant-workspace__body"><aside className="assistant-conversation-pane" aria-label={t('assistant.workspace.history')}>
      <Button variant="primary" onClick={()=>void create()}><Plus size={16}/>{t('assistant.workspace.new_conversation')}</Button>
      <Button variant="quiet" onClick={()=>setLegacy(true)}>{nt('legacyHistory')}</Button>
      <form className="native-project" onSubmit={e=>{e.preventDefault();openWorkspace(directoryDraft);}}><label>{t('assistant.scope.cwd')}<input dir="ltr" value={directoryDraft} onChange={e=>setDirectoryDraft(e.target.value)}/></label><Button type="submit" variant="secondary">{nt('project')}</Button></form>
      <Button variant="quiet" onClick={()=>setProjectsOpen(true)}>{nativeProjectText(locale,'projects')}</Button>
      <Button variant="quiet" onClick={()=>setSessionIndexOpen(true)}>{nativeSessionText(locale,'browse')}</Button>
      <div className="assistant-conversation-list">{sessions.map(item=><button key={item.id} type="button" className={item.id===active?'is-active':''} onClick={()=>select(item.id)}><span><strong>{item.title||t('assistant.workspace.untitled')}</strong><small>{new Intl.DateTimeFormat(locale,{dateStyle:'short'}).format(item.time.updated)}</small></span></button>)}</div>
    </aside><main className="assistant-conversation-main">
      <nav className="native-actions native-session-toolbar" aria-label={t('assistant.workspace.history')}>
        {active&&<Button variant="quiet" onClick={()=>{setError('');setShellOpen(true);}}>{nativeShellText(locale,'title')}</Button>}
        <Button variant="quiet" onClick={()=>setTransferOpen(true)}>{nativeTransferText(locale,'transfer')}</Button>
        {selectedSession?.parentID&&<Button variant="quiet" onClick={()=>select(selectedSession.parentID!)}>{nt('parent')}</Button>}
        <Button variant="quiet" onClick={()=>setTools(true)}>{nt('files')} / {nt('terminal')}</Button><Button variant="quiet" onClick={()=>void openDetail('skills')}>{nt('skills')}</Button>
        {active&&<><Button variant="quiet" onClick={()=>{setTitle(sessions.find(s=>s.id===active)?.title??'');setDialog('rename');}}>{nt('rename')}</Button><Button variant="quiet" onClick={()=>void fork()}>{nt('fork')}</Button><Button variant="quiet" onClick={()=>void openDetail('changes')}>{nt('changes')}</Button><Button variant="quiet" onClick={()=>void openDetail('context')}>{nt('context')}</Button><Button variant="quiet" disabled={!model&&!Object.keys(providers.default).length} onClick={()=>void compact()}>{nt('compact')}</Button><Button variant="quiet" onClick={()=>void mutate(`/session/${segment(active)}/unrevert`)}>{nt('redo')}</Button><Button variant="quiet" onClick={()=>setDialog('delete')}>{nt('delete')}</Button></>}
      </nav>
      {error&&<div className="assistant-error" role="alert"><span>{error}</span><button type="button" onClick={()=>void refresh()} aria-label={t('assistant.workspace.retry')}><RefreshCw size={16}/></button></div>}
      <div className="assistant-transcript" aria-live="polite">
        {!shownMessages.length&&<div className="assistant-empty"><Bot size={28}/><h3>{t('assistant.workspace.empty_title')}</h3><p>{t('assistant.workspace.empty_body')}</p></div>}
        {shownMessages.map(message=><article key={message.info.id} className={`assistant-message assistant-message--${message.info.role}`}><div className="assistant-message__body">
          <header><strong>{t(message.info.role==='user'?'assistant.workspace.you':'assistant.workspace.assistant')}</strong><time>{new Intl.DateTimeFormat(locale,{timeStyle:'short'}).format(message.info.time.created)}</time></header>
          {pendingMessages.has(message.info.id)&&<span className="native-pending" data-native-pending={message.info.id}>{nativeSessionText(locale,'queued')}</span>}
          {message.parts.map(part=>part.type==='text'?<div key={part.id} className="assistant-message__content">{part.text}</div>:
            <details key={part.id} className="native-part"><summary>{part.tool??part.filename??part.type}{part.state?` · ${part.state.status}`:''}</summary><pre>{part.state?pretty(part.state):pretty(part)}</pre></details>)}
          {message.info.tokens&&<footer>{t('assistant.workspace.usage',{input:message.info.tokens.input,output:message.info.tokens.output})}</footer>}
          {message.info.error!=null&&<pre role="alert">{pretty(message.info.error)}</pre>}
          <NativeMessageEditor client={client} directory={directory} message={message} running={Boolean(active&&status[active]&&status[active].type!=='idle')} locale={locale} onError={report} onSaved={()=>{setError('');void refresh();}}/>
          {message.info.role==='user'&&<div className="native-message-actions"><Button variant="quiet" onClick={()=>void fork(message.info.id)}>{nt('fork')}</Button><Button variant="quiet" disabled={Boolean(active&&status[active]&&status[active].type!=='idle')} onClick={()=>void mutate(`/session/${segment(active!)}/revert`,{messageID:message.info.id})}>{nt('undo')}</Button></div>}
        </div></article>)}
        {!!todos.length&&<details className="native-part"><summary>{nt('tasks')}</summary><ul>{todos.map((item,i)=><li key={i}>{item.content} · {item.status} · {item.priority}</li>)}</ul></details>}
        {!!children.length&&<details className="native-part"><summary>{nt('children')}</summary>{children.map(child=><Button key={child.id} variant="secondary" onClick={()=>select(child.id)}>{child.title}</Button>)}</details>}
        {permissions.filter(p=>p.sessionID===active).map(p=><article key={p.id} className="assistant-confirmation"><strong>{p.permission}</strong><pre>{pretty({patterns:p.patterns,...p.metadata})}</pre>
          <div className="native-actions">{(['once','always','reject'] as const).map(reply=><Button key={reply} disabled={acting.has(`/permission/${segment(p.id)}/reply`)} variant="secondary" onClick={()=>void mutate(`/permission/${segment(p.id)}/reply`,{reply})}>{nt(reply)}</Button>)}</div></article>)}
        {questions.filter(q=>q.sessionID===active).map(q=><NativeQuestionForm key={q.id} question={q} t={t} onReply={answers=>mutate(`/question/${segment(q.id)}/reply`,{answers})} onReject={()=>mutate(`/question/${segment(q.id)}/reject`)}/>)}
        {failed.map((item,index)=><div key={index} className="assistant-error"><span>{nt('uncertain')}</span><pre>{item.text}</pre><span>{item.files.map(f=>f.name).join(', ')}</span><Button variant="secondary" disabled={Boolean(draft||files.length)} onClick={()=>{setDraft(item.text);setFiles(item.files);setCommand(item.command);setAgent(item.agent);setModel(item.model);setDirectory(item.directory);setDirectoryDraft(item.directory);select(item.sessionId,item.directory);setFailed(items=>items.filter((_,i)=>i!==index));}}>{nt('restore')}</Button></div>)}
      </div>
      <form className="assistant-workspace__composer" onSubmit={send}><div className="assistant-compose-surface">
        <textarea className="assistant-compose-input" aria-label={t('assistant.workspace.composer_label')} value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}}} rows={2} placeholder={t('assistant.workspace.composer_placeholder')}/>
        <div className="assistant-compose-row"><label className="assistant-attach"><Paperclip size={17}/><input type="file" multiple aria-label={t('assistant.workspace.attach')} onChange={e=>{const selected=Array.from(e.target.files??[]);setFiles(items=>[...items,...selected]);e.target.value='';}}/></label>
          <select aria-label={nt('agent')} value={agent} onChange={e=>setAgent(e.target.value)}><option value="">{nt('agent')}</option>{agents.filter(a=>!a.hidden&&a.mode!=='subagent').map(a=><option key={a.name} value={a.name}>{a.name}</option>)}</select>
          <select aria-label={nt('model')} value={model} onChange={e=>setModel(e.target.value)}><option value="">{nt('model')}</option>{providers.providers.flatMap(p=>Object.values(p.models).map(m=><option key={`${p.id}/${m.id}`} value={`${p.id}\n${m.id}`}>{p.name} · {m.name}</option>))}</select>
          <select aria-label={nt('command')} value={command} onChange={e=>setCommand(e.target.value)}><option value="">{nt('command')}</option>{commands.map(item=><option key={item.name} value={item.name} title={item.description}>/{item.name}</option>)}</select>
          {active&&status[active]&&status[active].type!=='idle'&&<button type="button" className="assistant-stop" aria-label={t('assistant.workspace.stop')} onClick={()=>void mutate(`/session/${segment(active)}/abort`)}><CircleStop size={18}/></button>}
          <Button type="submit" variant="primary" disabled={busy||(!draft.trim()&&!files.length&&!command)} aria-label={t('assistant.send')}><SendHorizontal size={18}/>{t('assistant.send')}</Button>
        </div>{files.map((file,i)=><div className="assistant-attachment" key={i}>{file.name}<button type="button" onClick={()=>setFiles(items=>items.filter((_,j)=>i!==j))} aria-label={t('assistant.workspace.remove_attachment')}><X size={12}/></button></div>)}
      </div></form>
    </main></div>
    {projectsOpen&&<EditorDialog title={nativeProjectText(locale,'projects')} closeLabel={t('common.close')} busy={false} onCancel={()=>setProjectsOpen(false)} feedback={error}><NativeProjects key={directory} client={client} directory={directory} locale={locale} onOpen={openWorkspace} onError={report}/></EditorDialog>}
    {sessionIndexOpen&&<EditorDialog title={nativeSessionText(locale,'browse')} closeLabel={t('common.close')} busy={false} onCancel={()=>setSessionIndexOpen(false)} feedback={error}><NativeSessionIndex client={client} directory={directory} locale={locale} onError={report} onOpen={item=>{setDirectory(item.directory);setDirectoryDraft(item.directory);select(item.id,item.directory);setSessionIndexOpen(false);}}/></EditorDialog>}
    {shellOpen&&active&&<EditorDialog title={nativeShellText(locale,'title')} closeLabel={t('common.close')} busy={false} onCancel={()=>setShellOpen(false)} feedback={error}><NativeSessionShell key={`${directory}:${active}`} client={client} directory={directory} sessionId={active} locale={locale} agent={agent} model={model} running={Boolean(status[active]&&status[active].type!=='idle')} onError={report} onResult={()=>{setError('');void refresh();}}/></EditorDialog>}
    {transferOpen&&<EditorDialog title={nativeTransferText(locale,'transfer')} closeLabel={t('common.close')} busy={false} onCancel={()=>setTransferOpen(false)} feedback={error}><NativeSessionTransfer key={directory} client={client} directory={directory} sessionId={active} running={Boolean(active&&status[active]&&status[active].type!=='idle')} locale={locale} onError={report} onImported={session=>{setTransferOpen(false);select(session.id);}}/></EditorDialog>}
    {tools&&<EditorDialog title={`${nt('files')} / ${nt('terminal')}`} closeLabel={t('common.close')} busy={false} onCancel={()=>setTools(false)} feedback={error}><NativeWorkspaceTools key={directory} client={client} directory={directory} locale={locale} onError={report}/></EditorDialog>}
    {legacy&&<EditorDialog title={nt('legacyHistory')} closeLabel={t('common.close')} busy={false} onCancel={()=>setLegacy(false)} feedback={error}><LegacyAssistantHistory locale={locale} onError={report} onResume={session=>{
      void client.request<NativeSession>(`/session/${segment(session.id)}`,{directory:session.directory}).then(value=>{
        if(client.signal.aborted)return;setDirectory(session.directory);setDirectoryDraft(session.directory);select(value.id,session.directory);setLegacy(false);
      }).catch(report);
    }}/></EditorDialog>}
    {dialog&&<EditorDialog title={nt(dialog)} closeLabel={t('common.close')} busy={saving} onCancel={()=>{setDialog(null);setDetail(null);}} feedback={error}>
      {dialog==='context'&&Array.isArray(detail)&&<NativeContext messages={detail as NativeMessage[]} locale={locale} t={t}/>}
      {dialog==='changes'&&active&&Array.isArray(detail)&&<NativeChanges client={client} sessionId={active} directory={directory} messages={detail as NativeMessage[]} locale={locale} onError={report}/>}
      {dialog==='rename'||dialog==='delete'?<form onSubmit={e=>{e.preventDefault();void editSession();}}>{dialog==='rename'?<input aria-label={nt('rename')} value={title} onChange={e=>setTitle(e.target.value)} required/>:<p>{nt('deleteConfirm')}</p>}<Button variant="primary" disabled={saving} type="submit">{dialog==='delete'?nt('delete'):nt('save')}</Button></form>:dialog==='skills'&&Array.isArray(detail)?<div className="native-skill-list">{(detail as {name:string;description?:string;location:string;content:string}[]).map(skill=><article key={skill.name}><h3>{skill.name}</h3><p>{skill.description}</p><code>{skill.location}</code><details><summary>{nt('context')}</summary><pre className="native-detail">{skill.content}</pre></details><Button variant="secondary" disabled={!commands.some(item=>item.name===skill.name)} onClick={()=>{setCommand(skill.name);setDialog(null);}}>{nt('command')} /{skill.name}</Button></article>)}</div>:(dialog==='context'||dialog==='changes')&&detail!==null?null:<pre className="native-detail">{detail===null?'…':pretty(detail)}</pre>}
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

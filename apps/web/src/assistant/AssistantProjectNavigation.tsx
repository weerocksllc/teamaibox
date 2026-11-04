import {useEffect,useState} from 'react';
import {Button} from '@teamaibox/ui-system/components';
import type {Locale} from '../i18n';
import type {NativeClient,NativeSession} from './native-client';
import {projectDirectories,projectSelection,type AssistantBrowserState,type WorkspaceSelection} from './assistant-browser-state';
import {projectSessionText} from './project-session-copy';
import {AssistantDesignIcon as Icon} from './AssistantDesignIcon';
import {nativeSessionText} from './native-session-copy';
import {CompanyFooter} from '../CompanyFooter';

type Project={id:string;name?:string;worktree:string;sandboxes?:string[]};
export const directoryName=(directory:string)=>directory.split('/').filter(Boolean).at(-1)??directory;
export function useAssistantProjects(client:NativeClient,current:NativeSession[],state:AssistantBrowserState,onError:(error:unknown)=>void){
  const [projects,setProjects]=useState<Project[]>([]),[recent,setRecent]=useState<NativeSession[]>([]);
  const revision=current.map(s=>`${s.id}:${s.title}:${s.time.updated}:${s.time.archived??''}`).join('|');
  useEffect(()=>{let stale=false;void Promise.all([client.request<Project[]>('/project'),client.sessionPage(new URLSearchParams({limit:'50',archived:'false'}))]).then(([p,s])=>{
    if(!stale&&!client.signal.aborted){setProjects(p);setRecent(s.items);}
  }).catch(error=>{if(!stale)onError(error);});return()=>{stale=true;};},[client,revision,onError]);
  const all=[...current,...recent.filter(s=>!current.some(c=>c.id===s.id))].filter(s=>!s.time.archived);
  const directories=projectDirectories(projects,all,state.recent());
  return {directories,sessions:all,projectName:(directory:string)=>projects.find(p=>p.worktree===directory)?.name||directoryName(directory)};
}
type Props={directory:string;active:string|null;directories:string[];sessions:NativeSession[];projectName:(d:string)=>string;locale:Locale;state:AssistantBrowserState;newConversationLabel:string;onSelect:(s:WorkspaceSelection)=>void;onHome:()=>void;onNew:()=>void;onFolder:()=>void;onSearch:()=>void;onSettings:()=>void;onClose?:()=>void};
export function AssistantProjectNavigation(p:Props){
  const pt=(key:Parameters<typeof projectSessionText>[1])=>projectSessionText(p.locale,key);
  const open=(directory:string)=>p.onSelect(projectSelection(directory,p.state.recent(),p.sessions));
  return <aside className="assistant-project-navigation" aria-label={pt('navigation')}>
    <div className="assistant-project-label"><button type="button" onClick={p.onHome}>{pt('projects')}</button><Button variant="quiet" aria-label={pt('newProject')} onClick={p.onNew}><Icon name="plus"/></Button>{p.onClose&&<Button className="assistant-mobile-close" variant="quiet" onClick={p.onClose} aria-label={pt('navigation')}><Icon name="close"/></Button>}</div>
    <nav className="assistant-project-tree">{p.directories.map(directory=><div key={directory}>
      <button type="button" className={`assistant-project-row ${p.directory===directory?'is-active':''}`} onClick={()=>open(directory)} aria-expanded={p.directory===directory} title={directory}><Icon name="folder"/><span><strong>{p.projectName(directory)}</strong><small dir="ltr">{directory}</small></span></button>
      {p.directory===directory&&<div className="assistant-project-sessions">
        <Button variant="primary" onClick={()=>p.onSelect({directory,sessionId:null})}>{p.newConversationLabel}</Button>
        {p.sessions.filter(s=>s.directory===directory).map(item=><button type="button" key={item.id} className={`assistant-session-row ${p.active===item.id?'is-active':''}`} onClick={()=>p.onSelect({directory,sessionId:item.id})} aria-current={p.active===item.id?'page':undefined}><Icon name="chat"/><span><strong>{item.title}</strong><small>{new Intl.DateTimeFormat(p.locale,{dateStyle:'short'}).format(item.time.updated)}</small></span></button>)}
      </div>}
    </div>)}<Button variant="quiet" onClick={p.onSearch}><Icon name="search"/>{nativeSessionText(p.locale,'browse')}</Button></nav>
    <footer><Button variant="quiet" onClick={p.onFolder}><Icon name="plus"/>{pt('openFolder')}</Button><Button variant="quiet" onClick={p.onSettings}>{pt('projectSettings')}</Button><p>{pt('workspace')}</p></footer><CompanyFooter placement="sidebar"/>
  </aside>;
}
export function AssistantProjectHome({directories,sessions,projectName,locale,onOpen,onFolder,onNew,onSearch,lastSelections=[]}:{directories:string[];sessions:NativeSession[];projectName:(d:string)=>string;locale:Locale;onOpen:(selection:WorkspaceSelection)=>void;onFolder:()=>void;onNew:()=>void;onSearch:()=>void;lastSelections?:WorkspaceSelection[]}){
  const pt=(key:Parameters<typeof projectSessionText>[1])=>projectSessionText(locale,key);
  return <div className="assistant-project-home"><p className="assistant-section-label">{pt('workspace')}</p><h1>{pt('homeTitle')}</h1><p>{pt('homeBody')}</p>
    <div className="native-actions"><Button variant="primary" onClick={onFolder}>{pt('openFolder')}</Button><Button variant="secondary" onClick={onNew}>{pt('newProject')}</Button></div>
    <div className="assistant-project-cards">{directories.map(directory=><button type="button" key={directory} onClick={()=>onOpen(projectSelection(directory,lastSelections,sessions))}><strong><Icon name="folder"/>{projectName(directory)}</strong><code dir="ltr">{directory}</code><span>{pt('openProject')} <Icon name="right"/></span></button>)}</div>
    <div className="assistant-project-label"><h2>{pt('recents')}</h2><Button variant="quiet" onClick={onSearch}><Icon name="search"/>{nativeSessionText(locale,'browse')}</Button></div>
    <div className="assistant-recent-list">{sessions.slice(0,8).map(item=><button type="button" key={item.id} onClick={()=>onOpen({directory:item.directory,sessionId:item.id})}><Icon name="chat"/><span><strong>{item.title}</strong><small>{projectName(item.directory)}</small></span><time>{new Intl.DateTimeFormat(locale,{dateStyle:'short'}).format(item.time.updated)}</time></button>)}</div>
  </div>;
}

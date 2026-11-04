import {isNativeWorkspace} from './native-workspace-path.ts';

export type DraftAttachment={name:string;size:number;type:string;lastModified:number;file?:File};
export type AssistantDraft={text:string;agent:string;model:string;command:string;attachments:DraftAttachment[];revision:number};
type Storage=Pick<globalThis.Storage,'getItem'|'setItem'|'removeItem'>;
export type WorkspaceSelection={directory:string;sessionId:string|null};
export type RecentProject=WorkspaceSelection&{updated:number};
export const emptyAssistantDraft=():AssistantDraft=>({text:'',agent:'',model:'',command:'',attachments:[],revision:0});
export const canonicalWorkspace=(value:string)=>isNativeWorkspace(value)?value.replace(/\/+$/,'')||'/workspace':null;
export const attachmentFromFile=(file:File):DraftAttachment=>({name:file.name,size:file.size,type:file.type,lastModified:file.lastModified,file});
export function assistantAccountLocation(url:URL,previousIdentity:string|null,identity:string){
  const next=new URL(url);if(previousIdentity&&identity&&previousIdentity!==identity)for(const key of ['assistantSession','assistantDirectory','assistantView'])next.searchParams.delete(key);return next;
}

/** Browser presentation state only. Native OpenCode remains the session store. */
export class AssistantBrowserState {
  #identity:string; #storage:Storage|null; #drafts=new Map<string,AssistantDraft>();
  #stored=new Map<string,string|null>(); #listeners=new Set<()=>void>(); #revision=0;
  notice:'unavailable'|'conflict'|null=null;
  constructor(identity:string,storage:Storage|null){this.#identity=identity;this.#storage=storage;}
  subscribe=(listener:()=>void)=>{this.#listeners.add(listener);return()=>{this.#listeners.delete(listener);};};
  snapshot=()=>this.#revision;
  #emit(){this.#revision++;for(const listener of this.#listeners)listener();}
  #key(selection:WorkspaceSelection){
    const directory=canonicalWorkspace(selection.directory);if(!directory)throw new TypeError('Invalid workspace');
    return 'tab.assistant.v1:'+JSON.stringify([this.#identity,directory,selection.sessionId]);
  }
  #read(key:string){
    if(!this.#identity||!this.#storage)return null;
    try{return this.#storage.getItem(key);}catch{this.notice='unavailable';return null;}
  }
  get(selection:WorkspaceSelection):AssistantDraft{
    const key=this.#key(selection);const cached=this.#drafts.get(key);if(cached)return cached;
    const raw=this.#read(key);this.#stored.set(key,raw);let draft=emptyAssistantDraft();
    try{const value=JSON.parse(raw??'null');if(value&&['text','agent','model','command'].every(k=>typeof value[k]==='string')&&Array.isArray(value.attachments)){
      draft={text:value.text,agent:value.agent,model:value.model,command:value.command,revision:0,
        attachments:value.attachments.filter((a:DraftAttachment)=>typeof a?.name==='string'&&Number.isFinite(a.size)&&typeof a.type==='string').map((a:DraftAttachment)=>({name:a.name,size:a.size,type:a.type,lastModified:Number(a.lastModified)||0}))};
    }}catch{/* Invalid local data is not an input to the engine. */}
    this.#drafts.set(key,draft);return draft;
  }
  #persist(key:string,draft:AssistantDraft){
    if(!this.#identity||!this.#storage)return;
    try{
      if(this.#storage.getItem(key)!==(this.#stored.get(key)??null)){this.notice='conflict';return;}
      const raw=JSON.stringify({...draft,attachments:draft.attachments.map(({file:_,...metadata})=>metadata)});
      this.#storage.setItem(key,raw);this.#stored.set(key,raw);
    }catch{this.notice='unavailable';}
  }
  update(selection:WorkspaceSelection,patch:Partial<Omit<AssistantDraft,'revision'>>){
    const previous=this.get(selection),key=this.#key(selection);
    const next={...previous,...patch,revision:previous.revision+1};this.#drafts.set(key,next);this.#persist(key,next);this.#emit();return next;
  }
  remove(selection:WorkspaceSelection){
    const key=this.#key(selection);this.#drafts.delete(key);
    if(this.#identity&&this.#storage)try{this.#storage.removeItem(key);}catch{this.notice='unavailable';}
    this.#stored.delete(key);this.#emit();
  }
  move(from:WorkspaceSelection,to:WorkspaceSelection){
    const source=this.get(from),target=this.get(to);
    if(target.text||target.attachments.length)return false;
    this.update(to,source);this.remove(from);return true;
  }
  recent():RecentProject[]{
    try{const value=JSON.parse(this.#read(this.#recentKey())??'[]');return Array.isArray(value)?value.filter(item=>canonicalWorkspace(item?.directory)&&Number.isFinite(item.updated)&&(item.sessionId===null||/^ses_[A-Za-z0-9]+$/.test(item.sessionId))).slice(0,30):[];}catch{return [];}
  }
  #recentKey(){return 'tab.assistant.projects.v1:'+this.#identity;}
  remember(selection:WorkspaceSelection){
    const directory=canonicalWorkspace(selection.directory);if(!directory||!this.#identity||!this.#storage)return;
    const entries=[{...selection,directory,updated:Date.now()},...this.recent().filter(p=>p.directory!==directory)].slice(0,30);
    try{this.#storage.setItem(this.#recentKey(),JSON.stringify(entries));}catch{this.notice='unavailable';}this.#emit();
  }
}

export function projectDirectories(projects:{worktree:string;sandboxes?:string[]}[],sessions:{directory:string}[],recent:RecentProject[]){
  return [...new Set([...projects.flatMap(p=>[p.worktree,...(p.sandboxes??[])]),...sessions.map(s=>s.directory),...recent.map(p=>p.directory)].map(canonicalWorkspace).filter((p):p is string=>Boolean(p)))];
}
export function projectSelection(directory:string,recent:WorkspaceSelection[],sessions:{directory:string;id:string}[]):WorkspaceSelection{
  return recent.find(item=>item.directory===directory)??{directory,sessionId:sessions.find(item=>item.directory===directory)?.id??null};
}

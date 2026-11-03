import {useEffect,useState} from 'react';
import {Button} from '@teamaibox/ui-system/components';
import type {Locale} from '../i18n';
import type {NativeClient} from './native-client';
import {nativeText} from './native-copy';

type Entry={description?:string;prompt?:string;template?:string;mode?:string;disable?:boolean;[key:string]:unknown};
type Settings={agent?:Record<string,Entry>;command?:Record<string,Entry>;instructions?:string[];plugin?:unknown[]};
const lines=(text:string)=>text.split(/\r?\n/).map(item=>item.trim()).filter(Boolean);
/** Native configuration only: OpenCode loads and executes these extensions. */
export function NativeCustomization({client,locale,onError,onSaved}:{client:NativeClient;locale:Locale;onError:(error:unknown)=>void;onSaved:()=>void}) {
  const nt=(key:Parameters<typeof nativeText>[1])=>nativeText(locale,key);
  const [settings,setSettings]=useState<Settings>({});
  const [kind,setKind]=useState<'agent'|'command'>('agent');const [name,setName]=useState('');
  const [description,setDescription]=useState('');const [prompt,setPrompt]=useState('');
  const [mode,setMode]=useState('all');const [enabled,setEnabled]=useState(true);
  const [instructions,setInstructions]=useState('');const [plugins,setPlugins]=useState('');
  const [busy,setBusy]=useState(false);const [loaded,setLoaded]=useState(false);
  useEffect(()=>{let stale=false;void client.request<Settings>('/global/config').then(value=>{
    if(stale)return;setSettings(value);setInstructions((value.instructions??[]).join('\n'));
    setPlugins((value.plugin??[]).filter((item):item is string=>typeof item==='string').join('\n'));setLoaded(true);
  }).catch(onError);return()=>{stale=true;};},[client,onError]);
  const choose=(nextKind:typeof kind,nextName:string)=>{
    const entry=settings[nextKind]?.[nextName];setKind(nextKind);setName(nextName);
    setDescription(entry?.description??'');setPrompt((nextKind==='agent'?entry?.prompt:entry?.template)??'');
    setMode(entry?.mode??'all');setEnabled(entry?.disable!==true);
  };
  const save=async(patch:Settings)=>{
    if(busy||!loaded)return;setBusy(true);
    try{const saved=await client.request<Settings>('/global/config',{method:'PATCH',body:patch});if(!client.signal.aborted){setSettings(saved);onSaved();}}
    catch(error){onError(error);}finally{if(!client.signal.aborted)setBusy(false);}
  };
  return <section className="native-customization">
    <details><summary>{nt('customAgent')} / {nt('command')}</summary>
      <div className="native-actions">{(['agent','command'] as const).map(type=><Button key={type} variant={kind===type?'primary':'secondary'} onClick={()=>choose(type,'')}>{nt(type==='agent'?'customAgent':'command')}</Button>)}</div>
      <select aria-label={nt('name')} value={Object.hasOwn(settings[kind]??{},name)?name:''} onChange={e=>choose(kind,e.target.value)}><option value="">+</option>{Object.keys(settings[kind]??{}).map(key=><option key={key}>{key}</option>)}</select>
      <form onSubmit={event=>{event.preventDefault();if(!name.trim()||!prompt.trim())return;void save({[kind]:{[name]:{...settings[kind]?.[name],description,...(kind==='agent'?{prompt,mode,disable:!enabled}:{template:prompt})}}});}}>
        <label>{nt('name')}<input value={name} required pattern="[A-Za-z0-9_-]+" disabled={busy} onChange={e=>setName(e.target.value)}/></label>
        <label>{nt('description')}<input value={description} disabled={busy} onChange={e=>setDescription(e.target.value)}/></label>
        <label>{nt('prompt')}<textarea value={prompt} required disabled={busy} onChange={e=>setPrompt(e.target.value)} rows={5}/></label>
        {kind==='agent'&&<><label>{nt('mode')}<select value={mode} disabled={busy} onChange={e=>setMode(e.target.value)}>{['all','primary','subagent'].map(value=><option key={value}>{value}</option>)}</select></label><label><input type="checkbox" checked={enabled} disabled={busy} onChange={e=>setEnabled(e.target.checked)}/>{nt('enabled')}</label></>}
        <Button type="submit" variant="primary" disabled={busy||!loaded}>{nt('save')}</Button>
      </form>
    </details>
    <details><summary>{nt('instructions')}</summary><form onSubmit={event=>{event.preventDefault();void save({instructions:lines(instructions)});}}><label>{nt('paths')}<textarea value={instructions} rows={4} onChange={e=>setInstructions(e.target.value)} disabled={busy}/></label><Button type="submit" variant="primary" disabled={busy||!loaded}>{nt('save')}</Button></form></details>
    <details><summary>{nt('plugins')}</summary><form onSubmit={event=>{event.preventDefault();void save({plugin:[...(settings.plugin??[]).filter(item=>typeof item!=='string'),...lines(plugins)]});}}><label>{nt('packages')}<textarea value={plugins} rows={4} onChange={e=>setPlugins(e.target.value)} disabled={busy}/></label><Button type="submit" variant="primary" disabled={busy||!loaded}>{nt('save')}</Button></form></details>
  </section>;
}

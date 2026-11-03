import {useEffect,useRef,useState} from 'react';
import {Button} from '@teamaibox/ui-system/components';
import type {Locale} from '../i18n';
import type {NativeClient,NativeFile} from './native-client';
import {nativeProjectText} from './native-project-copy';
import {nativeResultPath} from './native-workspace-path';

type Match={path:{text:string};lines:{text:string};line_number:number};
export function NativeFileSearch({client,directory,locale,onOpen,onError}:{client:NativeClient;directory:string;locale:Locale;onOpen:(file:NativeFile)=>void;onError:(error:unknown)=>void}){
  const [query,setQuery]=useState(''),[kind,setKind]=useState<'files'|'text'>('files');
  const [results,setResults]=useState<{path:string;line?:number;text?:string}[]|null>(null),[busy,setBusy]=useState(false);
  const generation=useRef(0);
  useEffect(()=>()=>{++generation.current;},[]);
  const pt=(key:Parameters<typeof nativeProjectText>[1])=>nativeProjectText(locale,key);
  const invalidate=()=>{++generation.current;setResults(null);setBusy(false);};
  const search=async()=>{
    if(!query.trim()||busy)return;
    const turn=++generation.current;setBusy(true);setResults(null);
    try{
      const values=kind==='files'?
        (await client.request<string[]>(`/find/file?query=${encodeURIComponent(query)}&type=file&limit=100`,{directory})).map(path=>({path})):
        (await client.request<Match[]>(`/find?pattern=${encodeURIComponent(query)}`,{directory})).map(item=>({path:item.path.text,line:item.line_number,text:item.lines.text}));
      const safe=values.flatMap(item=>{const path=nativeResultPath(item.path,directory);return path?[{...item,path}]:[];});
      if(turn===generation.current)setResults(safe);
    }catch(error){if(turn===generation.current)onError(error);}finally{if(turn===generation.current)setBusy(false);}
  };
  return <section className="native-file-search native-customization">
    <form onSubmit={event=>{event.preventDefault();void search();}}>
      <select aria-label={pt('search')} value={kind} onChange={event=>{invalidate();setKind(event.target.value as typeof kind);}}><option value="files">{pt('searchFiles')}</option><option value="text">{pt('searchText')}</option></select>
      <label>{pt(kind==='files'?'searchFiles':'searchText')}<input dir="auto" value={query} onChange={event=>{invalidate();setQuery(event.target.value);}}/></label>
      <Button type="submit" variant="secondary" disabled={busy||!query.trim()}>{pt('search')}</Button>
    </form>
    {results&&<ul className="native-file-list" aria-live="polite">{!results.length&&<li>{pt('noResults')}</li>}{results.map((item,i)=><li key={`${item.path}:${i}`}>
      <button type="button" onClick={()=>onOpen({name:item.path.split('/').at(-1)!,path:item.path,absolute:directory+'/'+item.path,type:'file',ignored:false})}><span dir="ltr">{item.path}{item.line?`:${item.line}`:''}</span>{item.text&&<pre>{item.text}</pre>}</button>
    </li>)}</ul>}
  </section>;
}

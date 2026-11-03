import {useEffect,useState} from 'react';
import type {Locale} from '../i18n';
import type {NativeClient} from './native-client';
import {nativeCatalogText} from './native-catalog-copy';
import {nativeModelChoice} from './native-model';

type Tool={id:string;description:string;parameters:unknown};
type Resource={name:string;uri:string;description?:string;mimeType?:string;client?:string};
/** Native discovery only. Resource URIs are text, not browser fetches or executable links. */
export function NativeToolCatalog({client,directory,locale,selection,onError}:{client:NativeClient;directory:string;locale:Locale;selection:string;onError:(error:unknown)=>void}){
  const ct=(key:Parameters<typeof nativeCatalogText>[1])=>nativeCatalogText(locale,key);
  const [open,setOpen]=useState(false);const [tools,setTools]=useState<Tool[]|null>(null);
  const [resources,setResources]=useState<Record<string,Resource>|null>(null);const [capabilities,setCapabilities]=useState<unknown>(null);
  const [model,setModel]=useState('');
  useEffect(()=>{
    if(!open)return;let stale=false;setTools(null);setResources(null);setCapabilities(null);setModel('');
    const load=async()=>{
      const config=await client.request<{model?:string}>('/config',{directory});
      const chosen=nativeModelChoice(selection,config.model);
      const params=new URLSearchParams({provider:chosen.providerID,model:chosen.modelID});
      const [list,entries,flags]=await Promise.all([client.request<Tool[]>(`/experimental/tool?${params}`,{directory}),client.request<Record<string,Resource>>('/experimental/resource',{directory}),client.request('/experimental/capabilities',{directory})]);
      if(stale||client.signal.aborted)return;setTools(list);setResources(entries);setCapabilities(flags);setModel(chosen.providerID+'/'+chosen.modelID);
    };
    void load().catch(error=>{if(!stale)onError(error);});return()=>{stale=true;};
  },[client,directory,open,selection,onError]);
  return <section className="native-tool-catalog native-customization"><details onToggle={event=>setOpen(event.currentTarget.open)}><summary>{ct('catalog')}</summary>
    <h4>{ct('tools')}</h4><code dir="ltr">{model}</code>
    {tools===null?<p>…</p>:tools.length?tools.map(tool=><details key={tool.id} data-native-tool={tool.id}><summary>{tool.id}</summary><p>{tool.description}</p><details><summary>{ct('parameters')}</summary><pre className="native-detail" dir="ltr">{JSON.stringify(tool.parameters,null,2)}</pre></details></details>):<p>{ct('empty')}</p>}
    <h4>{ct('resources')}</h4>{resources===null?<p>…</p>:Object.keys(resources).length?Object.entries(resources).map(([id,resource])=><article key={id} data-native-resource={id}><strong>{resource.name||id}</strong><p>{resource.description}</p><code dir="ltr">{resource.uri}</code><p>{resource.mimeType}</p></article>):<p>{ct('empty')}</p>}
    <details><summary>{ct('capabilities')}</summary><pre className="native-detail" dir="ltr">{capabilities===null?'…':JSON.stringify(capabilities,null,2)}</pre></details>
  </details></section>;
}

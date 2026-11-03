import {useEffect,useState} from 'react';
import type {Locale} from '../i18n';
import type {NativeClient} from './native-client';
import {nativeSettingsText} from './native-settings-copy';
import {NativeProjectSettings} from './NativeProjectSettings';
import {nativeSessionText} from './native-session-copy';

/** Read native runtime facts. Unavailable language tools are never presented as active. */
export function NativeRuntimeSettings({client,directory,locale,onError,onReload}:{client:NativeClient;directory:string;locale:Locale;onError:(error:unknown)=>void;onReload:()=>void}){
  const nt=(key:Parameters<typeof nativeSettingsText>[1])=>nativeSettingsText(locale,key);
  const [status,setStatus]=useState<Record<string,unknown>>({});
  const [effective,setEffective]=useState<unknown>(null);
  useEffect(()=>{
    let stale=false;
    for(const [key,path] of [['runtime','/global/health'],['languageServers','/lsp'],['formatters','/formatter'],['paths','/path']] as const){
      void client.request(path,{directory}).then(value=>{if(!stale)setStatus(items=>({...items,[key]:value}));}).catch(error=>{if(!stale)setStatus(items=>({...items,[key]:{error:error instanceof Error?error.message:String(error)}}));});
    }
    return()=>{stale=true;};
  },[client,directory]);
  return <section className="native-runtime-settings native-customization">
    <details><summary>{nt('runtime')}</summary>{(['runtime','languageServers','formatters','paths'] as const).map(key=><article key={key}><h4>{key==='paths'?nativeSessionText(locale,'paths'):nt(key)}</h4><pre className="native-detail" data-native-status={key}>{status[key]===undefined?'…':JSON.stringify(status[key],null,2)}</pre></article>)}</details>
    <details onToggle={event=>{if(event.currentTarget.open)void client.request('/config',{directory}).then(value=>{if(!client.signal.aborted)setEffective(value);}).catch(onError);}}><summary>{nt('projectSettings')}</summary>
      <code dir="ltr">{directory}</code><details><summary>{nt('effectiveSettings')}</summary><pre className="native-detail">{effective===null?'…':JSON.stringify(effective,null,2)}</pre></details>
      <NativeProjectSettings client={client} directory={directory} locale={locale} onError={onError} onReload={()=>{setEffective(null);void client.request('/config',{directory}).then(value=>{if(!client.signal.aborted)setEffective(value);}).catch(onError);onReload();}}/>
    </details>
  </section>;
}

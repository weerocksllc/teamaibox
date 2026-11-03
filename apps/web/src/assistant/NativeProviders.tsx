import {useEffect,useState} from 'react';
import {Button} from '@teamaibox/ui-system/components';
import type {Locale} from '../i18n';
import type {NativeClient} from './native-client';
import {nativeText} from './native-copy';

type Prompt={type:'text'|'select';key:string;message:string;placeholder?:string;options?:{label:string;value:string}[];when?:{key:string;op:'eq'|'neq';value:string}};
type Method={type:'api'|'oauth';label:string;prompts?:Prompt[]};
type Authorization={url:string;instructions:string;method:'auto'|'code'};
export function NativeProviders({client,directory,locale,onError,onSaved}:{client:NativeClient;directory:string;locale:Locale;onError:(error:unknown)=>void;onSaved:()=>void}) {
  const nt=(key:Parameters<typeof nativeText>[1])=>nativeText(locale,key);
  const [providers,setProviders]=useState<{id:string;name:string}[]>([]),[methods,setMethods]=useState<Record<string,Method[]>>({});
  const [provider,setProvider]=useState(''),[method,setMethod]=useState(-1),[key,setKey]=useState('');
  const [inputs,setInputs]=useState<Record<string,string>>({}),[code,setCode]=useState('');
  const [authorization,setAuthorization]=useState<Authorization|null>(null),[busy,setBusy]=useState(false);
  useEffect(()=>{let stale=false;void Promise.all([client.request<{all:{id:string;name:string}[]}>('/provider',{directory}),client.request<Record<string,Method[]>>('/provider/auth',{directory})]).then(([catalog,auth])=>{if(!stale){setProviders(catalog.all);setMethods(auth);}}).catch(onError);return()=>{stale=true;};},[client,directory,onError]);
  const reset=()=>{setKey('');setInputs({});setCode('');setAuthorization(null);};
  const selected=methods[provider]?.[method];
  const prompts=(selected?.prompts??[]).filter(prompt=>!prompt.when||(prompt.when.op==='eq'?inputs[prompt.when.key]===prompt.when.value:inputs[prompt.when.key]!==prompt.when.value));
  const run=async(action:()=>Promise<void>)=>{if(busy)return;setBusy(true);try{await action();}catch(error){onError(error);}finally{if(!client.signal.aborted)setBusy(false);}};
  const save=()=>run(async()=>{
    if(selected?.type==='oauth'){
      const result=await client.request<Authorization>(`/provider/${encodeURIComponent(provider)}/oauth/authorize`,{method:'POST',directory,body:{method,inputs:Object.fromEntries(prompts.map(prompt=>[prompt.key,inputs[prompt.key]??'']))}});
      const url=new URL(result.url);
      if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw Error('oauth_invalid_authorization_url');
      setInputs({});setAuthorization(result);
    }else{
      await client.request(`/auth/${encodeURIComponent(provider)}`,{method:'PUT',body:{type:'api',key},directory});reset();onSaved();
    }
  });
  const finish=()=>run(async()=>{await client.request(`/provider/${encodeURIComponent(provider)}/oauth/callback`,{method:'POST',directory,body:{method,...(authorization?.method==='code'?{code}:{})}});reset();onSaved();});
  const remove=()=>run(async()=>{await client.request(`/auth/${encodeURIComponent(provider)}`,{method:'DELETE',directory});reset();onSaved();});
  return <section className="native-providers native-customization"><h3>{nt('provider')}</h3>
    <label>{nt('provider')}<select aria-label={nt('provider')} value={provider} disabled={busy} onChange={event=>{reset();setProvider(event.target.value);setMethod(-1);}}><option value="">—</option>{providers.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {provider&&<><label>{nt('authenticate')}<select aria-label={nt('authenticate')} disabled={busy||authorization!==null} value={method} onChange={event=>{reset();setMethod(Number(event.target.value));}}><option value={-1}>API key</option>{(methods[provider]??[]).filter(item=>item.type==='oauth').map(item=><option key={methods[provider].indexOf(item)} value={methods[provider].indexOf(item)}>{item.label}</option>)}</select></label>
      {authorization?<form onSubmit={event=>{event.preventDefault();void finish();}}><p>{authorization.instructions}</p><a href={authorization.url} target="_blank" rel="noopener noreferrer">{nt('authenticate')}</a>{authorization.method==='code'&&<label>{nt('authorizationCode')}<input type="password" value={code} onChange={event=>setCode(event.target.value)} autoComplete="off" required disabled={busy}/></label>}<Button type="submit" disabled={busy}>{nt('save')}</Button></form>:<form onSubmit={event=>{event.preventDefault();void save();}}>
        {selected?.type==='oauth'?prompts.map(prompt=><label key={prompt.key}>{prompt.message}{prompt.type==='select'?<select value={inputs[prompt.key]??''} required disabled={busy} onChange={event=>setInputs(values=>({...values,[prompt.key]:event.target.value}))}><option value="">—</option>{prompt.options?.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>:<input value={inputs[prompt.key]??''} placeholder={prompt.placeholder} disabled={busy} autoComplete="off" onChange={event=>setInputs(values=>({...values,[prompt.key]:event.target.value}))}/>}</label>):<label>API key<input type="password" value={key} onChange={event=>setKey(event.target.value)} autoComplete="off" required disabled={busy}/></label>}
        <Button type="submit" disabled={busy}>{nt(selected?.type==='oauth'?'authenticate':'save')}</Button>
      </form>}<Button variant="quiet" disabled={busy} onClick={()=>void remove()}>{nt('disconnect')}</Button></>}
  </section>;
}

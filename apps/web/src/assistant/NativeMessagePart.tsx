import {AssistantAttachment} from './AssistantMessageMedia';
import {AssistantRichText} from './AssistantRichText';
import {useRichMessageContext} from './rich-message-context';
import {richMessageText} from './rich-message-copy';
import type {NativePart} from './native-client';
const raw=(value:unknown)=>JSON.stringify(value,null,2);
export function NativeMessagePart({part,streaming}:{part:NativePart;streaming:boolean}){
  const {locale}=useRichMessageContext();const t=(key:Parameters<typeof richMessageText>[1])=>richMessageText(locale,key);
  if(part.type==='text')return <AssistantRichText text={part.text??''} streaming={streaming&&part.time?.end===undefined}/>;
  if(part.type==='file')return <AssistantAttachment url={part.url} filename={part.filename} mime={part.mime}/>;
  if(part.type==='reasoning')return <details className="assistant-reasoning"><summary>{t('reasoning')}{streaming&&part.time?.end===undefined?' · '+t('running'):''}</summary><AssistantRichText text={part.text??''} streaming={streaming&&part.time?.end===undefined}/></details>;
  if(part.type==='tool'&&part.state){
    const {state}=part;const statuses=['pending','running','completed','error'] as const;const status=statuses.find(s=>s===state.status);
    return <details className="assistant-tool-card" data-tool-status={state.status}>
      <summary><strong>{part.tool}</strong><span>{state.title}</span><span className="assistant-tool-status">{status?t(status):state.status}</span></summary>
      {state.input!==undefined&&<section><h4>{t('input')}</h4><pre dir="auto">{raw(state.input)}</pre></section>}
      {state.output!==undefined&&<section><h4>{t('output')}</h4><pre dir="auto">{state.output}</pre></section>}
      {state.error&&<div role="alert" className="assistant-tool-error">{state.error}</div>}
      {state.attachments?.map((file,i)=><AssistantAttachment key={file.id??i} url={file.url} filename={file.filename} mime={file.mime}/>)}
      <details className="assistant-part-raw"><summary>{t('details')}</summary><pre>{raw(part)}</pre></details>
    </details>;
  }
  return <details className="native-part"><summary>{part.filename??part.type} · {t('details')}</summary><pre>{raw(part)}</pre></details>;
}

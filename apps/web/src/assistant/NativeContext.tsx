import type {Locale} from '../i18n';
import type {NativeMessage} from './native-client';
import {nativeText} from './native-copy';

// Display native v1 records, not the unrelated v2 event-store context. Do not
// reconstruct the model prompt or estimate token usage from rendered text.
export function NativeContext({messages,locale,t}:{messages:NativeMessage[];locale:Locale;t:(key:string,values?:Record<string,string|number>)=>string}) {
  const latest=messages.findLast(message=>message.info.role==='assistant'&&message.info.tokens);
  const summaries=messages.filter(message=>message.info.summary===true);
  return <div className="native-context">
    {latest&&<section><h3>{nativeText(locale,'model')}</h3>
      <p>{latest.info.providerID} / {latest.info.modelID}</p>
      <p>{t('assistant.workspace.usage',{input:latest.info.tokens!.input,output:latest.info.tokens!.output})}</p>
      {typeof latest.info.cost==='number'&&<p>{new Intl.NumberFormat(locale,{style:'currency',currency:'USD',maximumFractionDigits:6}).format(latest.info.cost)}</p>}
      <details><summary>{nativeText(locale,'context')}</summary><pre>{JSON.stringify(latest.info.tokens,null,2)}</pre></details>
    </section>}
    {summaries.map(message=><section key={message.info.id}><h3>{nativeText(locale,'compact')}</h3>
      <time>{new Intl.DateTimeFormat(locale,{dateStyle:'short',timeStyle:'short'}).format(message.info.time.created)}</time>
      {message.parts.filter(part=>part.type==='text').map(part=><p key={part.id} className="assistant-message__content">{part.text}</p>)}
    </section>)}
    {!latest&&!summaries.length&&<p>—</p>}
  </div>;
}

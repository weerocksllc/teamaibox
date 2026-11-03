// Opt-in local acceptance page. Not referenced by the production entry.
import {StrictMode,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {NativeAssistantWorkspace} from '../../src/assistant/NativeAssistantWorkspace';
import {createI18nRuntime,supportedLocales,type Locale} from '../../src/i18n';
import '@teamaibox/ui-system/tokens.css';
import '@teamaibox/ui-system/primitives.css';
import '../../src/styles.css';
import '../../src/precision.css';
import '../../src/premium-workspace.css';
import '../../src/focus-workspace.css';
function Fixture(){
  const [locale,setLocale]=useState<Locale>('en');
  const [visible,setVisible]=useState(true);const [theme,setTheme]=useState('dark');
  const i18n=createI18nRuntime({locale});
  return <><nav aria-label="Synthetic acceptance controls"><select aria-label="Fixture language" value={locale} onChange={e=>{setLocale(e.target.value as Locale);document.documentElement.lang=e.target.value;document.documentElement.dir=e.target.value==='ar'?'rtl':'ltr';}}>{supportedLocales.map(value=><option key={value}>{value}</option>)}</select><button onClick={()=>{const next=theme==='dark'?'light':'dark';setTheme(next);document.documentElement.dataset.theme=next;}}>Theme</button><button onClick={()=>setVisible(v=>!v)}>Toggle assistant</button></nav>
    <div style={{height:'calc(100dvh - 40px)',display:'flex',minHeight:0}}>{visible&&<NativeAssistantWorkspace locale={locale} t={i18n.translate} onClose={()=>setVisible(false)}/>}</div></>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture/></StrictMode>);

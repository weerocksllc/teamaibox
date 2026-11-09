// Opt-in local acceptance entry; not linked from the product or release build.
import {useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PenpotWorkspace} from '../../src/design/PenpotWorkspace';
import {createI18nRuntime,normalizeLocale,type Locale,localeDirections} from '../../src/i18n';
import '@teamaibox/ui-system/tokens.css';
import '@teamaibox/ui-system/primitives.css';
import '../../src/styles.css';
import '../../src/precision.css';
import '../../src/premium-workspace.css';
import '../../src/focus-workspace.css';
function Fixture(){
  const [identity,setIdentity]=useState<string|null>(null);
  const [locale,setLocale]=useState<Locale>('en');
  useEffect(()=>{const receive=(event:Event)=>setLocale(normalizeLocale((event as CustomEvent).detail));window.addEventListener('fixture-locale',receive);return()=>window.removeEventListener('fixture-locale',receive);},[]);
  useEffect(()=>{document.documentElement.lang=locale;document.documentElement.dir=localeDirections[locale];},[locale]);
  useEffect(()=>{void fetch('/api/auth/session').then(r=>r.json()).then(value=>setIdentity(value.identity?.id??value.session?.identity?.id??''));},[]);
  const i18n=createI18nRuntime({locale});
  return identity!==null&&<div className="app-frame">
    <aside className="sidebar" aria-label="Fixture platform sidebar"/>
    <div className="workspace"><header className="topbar">Fixture platform header</header></div>
    <nav className="mobile-nav">Fixture platform navigation</nav>
    <PenpotWorkspace identityId={identity} locale={locale} t={i18n.translate} onClose={()=>{}}/>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);

import {normalizeProductLocale,supportedLocaleCodes,productLocaleDirection} from './locale-registry.mjs';
import {translations} from './global-translations.mjs';
export {normalizeProductLocale,productLocaleDirection};
const reported=new Set();
/** Translate only explicitly supplied product-owned copy; never scan or rewrite the DOM. */
export function productText(locale,english,chinese=english,values={}){
  const active=normalizeProductLocale(locale);let text;
  if(active==='zh-CN')text=chinese;
  else if(active==='en')text=english;
  else text=translations[active]?.[english];
  if(typeof text!=='string'){
    text=english??chinese??'';
    const key=`${active}:${english}`;
    if(!reported.has(key)){reported.add(key);console.warn('[localization] missing product string',active,english);}
  }
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g,(token,key)=>Object.hasOwn(values,key)?String(values[key]):token);
}
/** Existing English/Chinese catalogs stay authoritative; late string additions remain visible. */
export function localizedCatalogs(source){
 const locales=new Map();
 return new Proxy(source,{get(target,locale,receiver){
   if(typeof locale!=='string'||!supportedLocaleCodes.includes(locale)||Reflect.has(target,locale))return Reflect.get(target,locale,receiver);
   if(!locales.has(locale))locales.set(locale,new Proxy({}, {
     get(_,key){if(typeof key!=='string')return undefined;const en=target.en?.[key],zh=(target['zh-CN']??target.zh)?.[key];if(en===undefined&&zh===undefined)return undefined;return productText(locale,en??zh,zh??en);},
     ownKeys(){return Object.keys(target.en??{});},getOwnPropertyDescriptor(_,key){return Object.hasOwn(target.en??{},key)?{enumerable:true,configurable:true}:undefined;},
   }));
   return locales.get(locale);
 }});
}
/** Only explicitly annotated, product-owned labels are touched. Result/user text is never scanned. */
export function applyProductLabels(root,locale){
 const doc=root.ownerDocument??root;
 doc.documentElement.lang=normalizeProductLocale(locale);
 doc.documentElement.dir=productLocaleDirection(locale);
 for(const el of root.querySelectorAll('[data-ui-copy]'))el.textContent=productText(locale,el.dataset.uiCopy,el.dataset.uiCopyZh??el.dataset.uiCopy);
 const names=new Intl.DisplayNames([normalizeProductLocale(locale)],{type:'language'});
 for(const el of root.querySelectorAll('option[data-ui-language]'))el.textContent=names.of(el.dataset.uiLanguage)??el.dataset.uiLanguage;
 // Existing application-specific labels are applied synchronously by callers
 // immediately after this helper. Announce the completed render, not API readiness.
 queueMicrotask(()=>{
  const active=normalizeProductLocale(locale);
  if(doc.documentElement.lang!==active)return;
  doc.documentElement.dataset.uiPresentedLocale=active;
  const view=doc.defaultView,app=doc.body?.dataset.uiApp;
  if(view&&view.parent!==view&&app)view.parent.postMessage({
   type:'teamaibox.plugin-presentation-ready/v1',pluginId:`official.${app}`,locale:active,
  },view.location.origin);
 });
}

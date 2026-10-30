import {useEffect} from 'react';
import {supportedLocaleCodes, type ProductLocale} from '../../../../packages/ui-system/src/locale-registry.mjs';
import type {AppearanceTheme} from './AppearancePreferences';

/** Other tabs follow explicit choices without writing them back to the account again. */
export function useAppearanceSync(setLocale:(locale:ProductLocale)=>void,setTheme:(theme:AppearanceTheme)=>void){
 useEffect(()=>{
  const receive=(event:StorageEvent)=>{
   if(event.key==='teamaibox.recent-locale'&&supportedLocaleCodes.includes(event.newValue as ProductLocale))setLocale(event.newValue as ProductLocale);
   if(event.key==='teamaibox.recent-theme'&&['light','dark','system'].includes(event.newValue??''))setTheme(event.newValue as AppearanceTheme);
  };
  window.addEventListener('storage',receive);
  return()=>{window.removeEventListener('storage',receive);};
 },[setLocale,setTheme]);
}

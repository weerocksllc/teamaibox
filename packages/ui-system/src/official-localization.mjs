import {supportedLocaleCodes} from './locale-registry.mjs';
const bundled=new Set(['assistant','messaging','team-drive','drawing','ocr','asr','translation','virtual-phones','virtual-computers','wireless-casting'].map(x=>'official.'+x));
export const officialLocalization=Object.freeze({supportedLocales:supportedLocaleCodes,fallbackLocale:'zh-CN',supportedDirections:Object.freeze(['ltr','rtl']),rtlReady:true});
// Presentation metadata ships with the bundled frontend release. Do not rewrite
// signed import history, permissions, health or third-party declarations.
export function releasedLocalization(pluginKey,manifest){
 return manifest?.official===true&&bundled.has(pluginKey)?officialLocalization:manifest?.localization??null;
}

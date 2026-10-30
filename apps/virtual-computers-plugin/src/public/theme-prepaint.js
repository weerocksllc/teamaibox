// Generated from locale-registry.mjs by tools/complete-static-ui-locales.mjs. Appearance only.
(()=>{
/** Product UI locales, shared by account preferences and all first-party views. */
const localeDefinitions = Object.freeze([
  ['zh-CN','简体中文','ltr'],['zh-TW','繁體中文','ltr'],['en','English','ltr'],
  ['ja','日本語','ltr'],['ko','한국어','ltr'],['fr','Français','ltr'],['de','Deutsch','ltr'],
  ['es','Español','ltr'],['pt-BR','Português','ltr'],['ru','Русский','ltr'],['ar','العربية','rtl'],
  ['hi','हिन्दी','ltr'],['id','Bahasa Indonesia','ltr'],['it','Italiano','ltr'],['tr','Türkçe','ltr'],
  ['vi','Tiếng Việt','ltr'],['th','ไทย','ltr'],
].map(([code,name,direction])=>Object.freeze({code,name,direction})));
const supportedLocaleCodes=Object.freeze(localeDefinitions.map(value=>value.code));
function normalizeProductLocale(candidate,fallback='zh-CN'){
  if(typeof candidate!=='string')return fallback;
  const value=candidate.trim().replaceAll('_','-').toLowerCase();
  const exact=localeDefinitions.find(item=>item.code.toLowerCase()===value);if(exact)return exact.code;
  const language=value.split('-')[0];
  if(language==='zh')return /(?:^|-)(?:tw|hk|mo|hant)(?:-|$)/.test(value)?'zh-TW':'zh-CN';
  if(language==='pt')return 'pt-BR';
  return localeDefinitions.find(item=>item.code===language)?.code??fallback;
}
function productLocaleDirection(locale){return normalizeProductLocale(locale)==='ar'?'rtl':'ltr';}
function productLocaleName(locale){return localeDefinitions.find(item=>item.code===normalizeProductLocale(locale))?.name??'English';}

const query=new URLSearchParams(location.search);const theme=query.get('theme')==='dark'?'dark':'light';document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;document.documentElement.lang=normalizeProductLocale(query.get('locale'));document.documentElement.dir=productLocaleDirection(document.documentElement.lang);})();

export type ProductLocale = 'zh-CN'|'zh-TW'|'en'|'ja'|'ko'|'fr'|'de'|'es'|'pt-BR'|'ru'|'ar'|'hi'|'id'|'it'|'tr'|'vi'|'th';
export const localeDefinitions: readonly Readonly<{code:ProductLocale;name:string;direction:'ltr'|'rtl'}>[];
export const supportedLocaleCodes: readonly ProductLocale[];
export function normalizeProductLocale(candidate:unknown,fallback?:ProductLocale):ProductLocale;
export function productLocaleDirection(locale:unknown):'ltr'|'rtl';
export function productLocaleName(locale:unknown):string;

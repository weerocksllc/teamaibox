import type { ProductLocale } from './locale-registry.mjs';
export { normalizeProductLocale, productLocaleDirection } from './locale-registry.mjs';
export function productText(locale: unknown, english: string, chinese?: string, values?: Record<string, unknown>): string;
export function localizedCatalogs<T extends Record<string, Record<string, string>>>(source: T): T & Record<string, Record<string, string>>;
export function applyProductLabels(root: Document | Element, locale: unknown): void;

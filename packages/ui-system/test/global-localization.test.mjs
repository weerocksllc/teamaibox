import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {translations} from '../src/global-translations.mjs';
import {localeDefinitions,normalizeProductLocale} from '../src/locale-registry.mjs';
import {productText,localizedCatalogs} from '../src/product-localization.mjs';
import {releasedLocalization} from '../src/official-localization.mjs';
const inventory=JSON.parse(await readFile(new URL('../../../docs/validation/global-localization-inventory-20261023.json',import.meta.url)));
const tokens=text=>(text.match(/\{[A-Za-z][A-Za-z0-9_]*\}/g)??[]).sort();
test('all 17 languages have complete source and placeholder coverage',()=>{
 assert.equal(localeDefinitions.length,17);
 for(const[locale,catalog]of Object.entries(translations))for(const source of inventory.sourceTexts){
  assert.equal(typeof catalog[source],'string',`${locale}: ${source}`);
  assert.ok(catalog[source].trim(),`${locale}: ${source}`);
  assert.deepEqual(tokens(catalog[source]),tokens(source),`${locale}: ${source}`);
  assert.doesNotMatch(catalog[source],/ZXQ\d|QXZ|ZXLBRXZ/);
 }
});
test('product names and shortcut identities remain stable',()=>{
 for(const{code}of localeDefinitions.filter(x=>!['zh-CN','en'].includes(x.code))){
  for(const text of ['Team AI Box','Android + Google Play','⌘ K'])assert.equal(productText(code,text),text);
 }
});
test('normalization, RTL and late-added catalogs do not translate user content',()=>{
 assert.equal(normalizeProductLocale('pt-PT'),'pt-BR');assert.equal(normalizeProductLocale('zh-Hant-HK'),'zh-TW');assert.equal(normalizeProductLocale('fr-CA'),'fr');
 assert.equal(localeDefinitions.find(x=>x.code==='ar').direction,'rtl');
 const source={en:{cancel:'Cancel'},'zh-CN':{cancel:'取消'}},catalog=localizedCatalogs(source);
 source.en.done='Cancel';source['zh-CN'].done='取消';assert.ok(catalog.ja.done);
 assert.equal(Object.hasOwn(catalog.ja,'user-provided-text'),false);
 assert.equal(catalog.ja['user-provided-text'],undefined);
});
test('bundled presentation metadata expands locales without mutating imported manifests',()=>{
 const original={official:true,localization:{supportedLocales:['zh-CN','en']}};
 assert.equal(releasedLocalization('official.virtual-phones',original).supportedLocales.length,17);
 assert.deepEqual(original.localization.supportedLocales,['zh-CN','en']);
 assert.equal(releasedLocalization('third-party.app',original),original.localization);
});
test('only the locale constraint changes and rollback never resets user preferences',async()=>{
 const up=await readFile(new URL('../../persistence/migrations/000110_product_languages.up.sql',import.meta.url),'utf8');
 for(const{code}of localeDefinitions)assert.ok(up.includes(`'${code}'`));
 assert.doesNotMatch(up,/\b(?:DELETE|UPDATE|TRUNCATE)\b/i);
 const down=await readFile(new URL('../../persistence/migrations/000110_product_languages.down.sql',import.meta.url),'utf8');
 assert.match(down,/RAISE EXCEPTION/);assert.doesNotMatch(down,/UPDATE iam/);
});

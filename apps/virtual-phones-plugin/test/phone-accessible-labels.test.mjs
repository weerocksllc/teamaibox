import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

test('phone accessible labels follow initial and live locale without changing contents', async()=>{
  const source=await readFile(new URL('../src/public/app.js',import.meta.url),'utf8');
  const html=await readFile(new URL('../src/public/index.html',import.meta.url),'utf8');
  const messageSource=source.slice(source.indexOf('const messages ='),source.indexOf('const $ ='))
    +[...source.matchAll(/Object\.assign\(messages[\s\S]*?\}\);/g)].map(match=>match[0]).join('\n');
  const messages=runInNewContext(messageSource+'; messages',{localizedCatalogs:value=>value});
  const keys=[...html.matchAll(/data-i18n-aria="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(new Set(keys).size,8);
  assert.match(html,/<dialog id="editor" aria-labelledby="dialog-title">/);
  const elements=keys.map(key=>({dataset:{i18nAria:key},textContent:'preserved',attributes:{},setAttribute(k,v){this.attributes[k]=v;}}));
  let locale='en';
  for(const lang of ['en','zh-CN'])for(const key of keys)assert.equal(typeof messages[lang][key],'string',`${lang}:${key}`);
  const context={state:{locale},t:key=>messages[locale][key],
    document:{documentElement:{},querySelectorAll:selector=>selector==='[data-i18n-aria]'?elements:[]},
    render(){},applyProductLabels(){},workspace:{translate(){}},phoneDebug:{translate(){}},phoneFiles:{translate(){}},phoneCamera:{translate(){}},
    $:()=>({open:false})};
  const translate=runInNewContext(source.slice(source.indexOf('function translate()'),source.indexOf('window.addEventListener("message"'))+'; translate',context);
  for (const lang of ['en','zh-CN','en']) {
    locale=lang;context.state.locale=lang;translate();
    for (const el of elements) {
      assert.equal(el.textContent,'preserved');
      assert.equal(el.attributes['aria-label'],context.t(el.dataset.i18nAria));
      if(lang==='en')assert.doesNotMatch(el.attributes['aria-label'],/[\u4e00-\u9fff]/);
    }
  }
  assert.equal(elements.find(el=>el.dataset.i18nAria==='quotaLabel').attributes['aria-label'],'Phone overview');
});

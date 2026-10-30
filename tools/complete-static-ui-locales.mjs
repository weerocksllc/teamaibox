import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const registry=readFileSync(resolve(root,'packages/ui-system/src/locale-registry.mjs'),'utf8').replaceAll('export ','');
for(const e of readdirSync(resolve(root,'apps'),{withFileTypes:true}))if(e.isDirectory()&&e.name.endsWith('-plugin')){
 const dir=resolve(root,'apps',e.name,'src/public');let paths;try{paths=readdirSync(dir);}catch{continue;}
 writeFileSync(resolve(dir,'product-localization.mjs'),"// Node/source import bridge. The application server serves the shared module at this same URL.\nexport * from '../../../../packages/ui-system/src/product-localization.mjs';\n");
 for(const file of paths){const path=resolve(dir,file);if(file.endsWith('.html')){
   let s=readFileSync(path,'utf8');
   s=s.replace(/<option value="(zh-CN|zh|en|ja|ko|fr|de)"(?! data-ui-language)>/g,'<option value="$1" data-ui-language="$1">');
   s=s.replaceAll('<option value="">Auto</option>','<option value="" data-ui-copy="Auto" data-ui-copy-zh="自动检测">Auto</option>');
   s=s.replaceAll('<option value="text">Text</option>','<option value="text" data-ui-copy="Text" data-ui-copy-zh="文本">Text</option>');
   s=s.replaceAll('<span data-stage="translation">Translation</span>','<span data-stage="translation" data-ui-copy="Translation" data-ui-copy-zh="翻译">Translation</span>');
   s=s.replaceAll('<span data-stage="subtitle">Subtitles</span>','<span data-stage="subtitle" data-ui-copy="Subtitles" data-ui-copy-zh="字幕">Subtitles</span>');
   writeFileSync(path,s);
 }
 if(['app.js','computers.mjs'].includes(file)){
   let s=readFileSync(path,'utf8');if(!s.includes('applyProductLabels')){
    s=`import {applyProductLabels} from './product-localization.mjs';\n`+s;
    if(file==='computers.mjs')s=s.replace('function render(){','function render(){\n applyProductLabels(document,locale);');
    else s=s.replace(/document.documentElement.lang\s*=\s*state.locale;/g,'document.documentElement.lang=state.locale;applyProductLabels(document,state.locale);');
    writeFileSync(path,s);
   }
 }
}
}
// Synchronous, generated prepaint code avoids a wrong-language or wrong-direction first frame.
writeFileSync(resolve(root,'apps/virtual-computers-plugin/src/public/theme-prepaint.js'),`// Generated from locale-registry.mjs by tools/complete-static-ui-locales.mjs. Appearance only.\n(()=>{\n${registry}\nconst query=new URLSearchParams(location.search);const theme=query.get('theme')==='dark'?'dark':'light';document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme;document.documentElement.lang=normalizeProductLocale(query.get('locale'));document.documentElement.dir=productLocaleDirection(document.documentElement.lang);})();\n`);

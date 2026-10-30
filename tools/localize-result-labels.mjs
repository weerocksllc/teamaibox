// Mechanical presentation-only replacements. No request payloads or data change.
import{readFile,writeFile}from'node:fs/promises';
const edits={
 'apps/asr-plugin/src/public/app.js':[
  ['(item.size/1048576).toFixed(1)','new Intl.NumberFormat(state.locale,{maximumFractionDigits:1}).format(item.size/1048576)'],
  ['.textContent=`${percent}%`','.textContent=new Intl.NumberFormat(state.locale,{style:"percent",maximumFractionDigits:0}).format(percent/100)'],
 ],
 'apps/team-drive-plugin/src/public/app.js':[
  ['`${ratio.toFixed(ratio<10?1:0)}%`','new Intl.NumberFormat(state.locale,{style:"percent",maximumFractionDigits:ratio<10?1:0}).format(ratio/100)'],
  ['.textContent=`${Math.round(percent)}%`','.textContent=new Intl.NumberFormat(state.locale,{style:"percent",maximumFractionDigits:0}).format(percent/100)'],
 ],
 'apps/translation-plugin/src/public/app.js':[
  ['(file.size/1048576).toFixed(2)','new Intl.NumberFormat(state.locale,{maximumFractionDigits:2}).format(file.size/1048576)'],
  ['(item.size/1048576).toFixed(1)','new Intl.NumberFormat(state.locale,{maximumFractionDigits:1}).format(item.size/1048576)'],
  ['.textContent=`${percent}%`','.textContent=new Intl.NumberFormat(state.locale,{style:"percent",maximumFractionDigits:0}).format(percent/100)'],
  ['source:value.source_language||"Auto",target:value.target_language','source:languageName(value.source_language),target:languageName(value.target_language)'],
  ['{value:value.input_kind}','{value:kindLabel(value.input_kind)}'],
  ['${stage.capability} ·','${kindLabel(stage.capability)} ·'],
  ['{kind:item.kind}','{kind:kindLabel(item.kind)}'],
 ],
 'apps/ocr-plugin/src/public/app.js':[
  ['${block.id} · ${block.block_type||"text"}','${block.id} · ${blockLabel(block.block_type||"text")}'],
 ],
};
for(const[file,pairs]of Object.entries(edits)){let s=await readFile(file,'utf8');for(const[a,b]of pairs)s=s.replaceAll(a,b);await writeFile(file,s);}

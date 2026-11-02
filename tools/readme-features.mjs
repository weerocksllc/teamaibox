import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const directory=path.join(root,'docs/readme-features');
const idPattern=/^[a-z][a-z0-9-]*$/;
function requireText(value,label){
  if(typeof value!=='string'||!value.trim())throw new Error(`${label}: missing feature copy`);
}

export function validateFeatureCopy(copy,reference,locale){
  for(const key of ['title','navigationTitle'])requireText(copy[key],`${locale}.${key}`);
  if(!Array.isArray(copy.groups))throw new Error(`${locale}: missing feature groups`);
  const ids=new Set();
  for(const group of copy.groups){
    if(!idPattern.test(group.id)||ids.has(group.id))throw new Error(`${locale}: invalid/duplicate group ${group.id}`);
    ids.add(group.id);requireText(group.title,`${locale}.${group.id}`);
    if(!Array.isArray(group.items)||!group.items.length)throw new Error(`${locale}.${group.id}: empty group`);
    const itemIds=new Set();
    for(const item of group.items){
      if(!idPattern.test(item.id)||itemIds.has(item.id))throw new Error(`${locale}.${group.id}: invalid/duplicate item ${item.id}`);
      itemIds.add(item.id);requireText(item.text,`${locale}.${group.id}.${item.id}`);
    }
  }
  const shape=value=>value.groups.map(g=>[g.id,g.items.map(i=>i.id)]);
  if(JSON.stringify(shape(copy))!==JSON.stringify(shape(reference)))throw new Error(`${locale}: feature coverage/order differs from English`);
  return copy;
}

export async function loadFeatureCopy(locale){
  const reference=JSON.parse(await fs.readFile(path.join(directory,'en.json'),'utf8'));
  const copy=locale==='en'?reference:JSON.parse(await fs.readFile(path.join(directory,`${locale}.json`),'utf8'));
  return validateFeatureCopy(copy,reference,locale);
}

export function renderFeatureChecklist(copy){
  return `<a id="features"></a>\n\n## ${copy.title}\n\n**${copy.navigationTitle}**\n\n${copy.groups.map(g=>`- [${g.title}](#feature-${g.id})`).join('\n')}\n\n${copy.groups.map(g=>`<a id="feature-${g.id}"></a>\n\n### ${g.title}\n\n${g.items.map(i=>`- ${i.text}`).join('\n')}`).join('\n\n')}`;
}

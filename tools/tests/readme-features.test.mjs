import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {localeDefinitions} from '../../packages/ui-system/src/locale-registry.mjs';
import {validateFeatureCopy,loadFeatureCopy,renderFeatureChecklist} from '../readme-features.mjs';
import {manifest,languages,readmePath,localizedPath,canonicalPath,sourceBody,blocks,hash,localizeLinks,navigation} from '../document-localization.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const fixture={title:'Features',navigationTitle:'Jump to a module',groups:[{id:'drive',title:'Drive',items:[{id:'upload',text:'Upload files.'}]}]};

test('missing or duplicated features cannot silently disappear in another language',()=>{
  assert.throws(()=>validateFeatureCopy({...fixture,groups:[]},fixture,'test'),/coverage/);
  assert.throws(()=>validateFeatureCopy({...fixture,groups:[...fixture.groups,...fixture.groups]},fixture,'test'),/duplicate/);
  assert.throws(()=>validateFeatureCopy({...fixture,groups:[{...fixture.groups[0],items:[{id:'upload',text:''}]}]},fixture,'test'),/missing feature copy/);
  assert.throws(()=>validateFeatureCopy({...fixture,groups:[{...fixture.groups[0],items:[{id:'remove',text:'Remove.'}]}]},fixture,'test'),/coverage/);
});

test('feature navigation uses stable anchors, not translated heading slugs',()=>{
  const text=renderFeatureChecklist(fixture);
  assert.ok(text.includes('[Drive](#feature-drive)'));
  assert.ok(text.includes('<a id="feature-drive"></a>'));
  assert.ok(text.includes('- Upload files.'));
});

test('every supported language has the same implemented feature inventory and rendered links',async()=>{
  const reference=await loadFeatureCopy('en');
  assert.ok(reference.groups.length>=13,'Inventory should cover the complete product, not only AI apps');
  assert.ok(reference.groups.reduce((n,g)=>n+g.items.length,0)>=80,'Expected a concrete long-form checklist');
  for(const {code} of localeDefinitions){
    const copy=await loadFeatureCopy(code);
    assert.ok(!Object.hasOwn(copy,'intro'),`${code}: internal acceptance preamble must not return`);
    const filename=code==='en'?'README.md':`README.${code}.md`;
    const text=await fs.readFile(path.join(root,filename),'utf8');
    assert.ok(text.includes(renderFeatureChecklist(copy)),`${code}: rendered feature list is stale`);
    for(const group of copy.groups){
      assert.ok(text.includes(`](#feature-${group.id})`),`${code}: group navigation`);
      for(const item of group.items){
        assert.ok(!/TODO|TRANSLATE_ME|\[placeholder\]/.test(item.text),`${code}.${item.id}: unfinished copy`);
        if(code!=='en'){
          const original=reference.groups.find(g=>g.id===group.id).items.find(i=>i.id===item.id).text;
          assert.notEqual(item.text,original,`${code}.${item.id}: English fallback`);
        }
      }
    }
  }
});

test('inventory evidence references shipped source paths rather than deployment reports',async()=>{
  const copy=await loadFeatureCopy('en');
  const evidence=JSON.parse(await fs.readFile(path.join(root,'docs/readme-features/evidence.json'),'utf8'));
  assert.deepEqual(Object.keys(evidence),copy.groups.map(g=>g.id));
  for(const [group,files] of Object.entries(evidence)){
    assert.ok(files.length>=1,group);
    for(const file of files){
      assert.ok(/^(apps|services|packages|install|deploy|tools|architecture|examples)\//.test(file),file);
      assert.ok(!file.includes('..')&&!file.includes('validation/'),file);
      await fs.access(path.join(root,file));
    }
  }
});

test('README links and quick-navigation anchors work in every language',async()=>{
  const switches=languages.map(l=>`[${l.name}](${readmePath(l.code)})`).join(' · ');
  for(const {code} of languages){
    const text=await fs.readFile(path.join(root,readmePath(code)),'utf8');
    const prose=text.replace(switches,'');
    for(const [,href] of prose.matchAll(/\]\(([^\s)]+)\)/g)){
      if(/^(?:[a-z]+:|\/\/)/i.test(href))continue;
      const [target,fragment]=href.split('#');
      const resolved=target||readmePath(code);
      assert.ok(!resolved.startsWith('/')&&!resolved.split('/').includes('..'),href);
      await fs.access(path.join(root,resolved));
      if(target.endsWith('.md'))assert.equal(target,localizedPath(canonicalPath(target),code),`${code}: ${href}`);
      if(fragment){
        const destination=target?await fs.readFile(path.join(root,target),'utf8'):text;
        assert.ok(destination.includes(`id="${fragment}"`),`${code}: missing anchor ${href}`);
      }
    }
    for(const anchor of ['features','install','contribute'])assert.ok(text.includes(`](#${anchor})`),`${code}: ${anchor}`);
    const oldCopy=JSON.parse(await fs.readFile(path.join(root,`docs/readme-locales/${code}.json`),'utf8'));
    assert.ok(!Object.hasOwn(oldCopy,'features'),'Replaced short feature summaries must not survive as a contradictory source');
    assert.ok(!Object.hasOwn(oldCopy,'screensNote'),'Screenshot production notes do not belong in product copy');
  }
});

test('all contribution guides document the feature catalog and match their translations',async()=>{
  const doc=manifest.documents.find(d=>d.path==='CONTRIBUTING.md');
  const body=sourceBody(await fs.readFile(path.join(root,doc.path),'utf8'),doc.path);
  for(const {code} of languages){
    const catalog=JSON.parse(await fs.readFile(path.join(root,`docs/document-locales/${code}.json`),'utf8'));
    const translated=blocks(body).map(block=>{
      if(!block.translate||code===doc.sourceLocale)return block.text;
      const text=catalog.messages[hash(block.text)];
      assert.ok(text?.trim(),`${code}: missing contribution paragraph`);
      return block.text.match(/^\s*/)[0]+text.trim()+block.text.match(/\s*$/)[0];
    }).join('');
    const text=await fs.readFile(path.join(root,localizedPath(doc.path,code)),'utf8');
    assert.equal(text,navigation(doc,code)+localizeLinks(translated,doc.path,code));
    assert.ok(text.includes('`docs/readme-features/<locale>.json`'));
    assert.ok(text.includes('`docs/readme-features/evidence.json`'));
  }
});

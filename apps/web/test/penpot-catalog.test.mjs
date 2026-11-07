import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createI18nRuntime,supportedLocales} from '../src/i18n.ts';
import {categoryConfiguration} from '../src/workbench-data.ts';
import {applicationsFromCatalogFacts,buildWorkbenchCatalog,searchWorkbenchCatalog} from '../src/catalog/workbench-catalog.mjs';

test('installed Design catalog uses localized copy in all platform languages and respects visibility',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../../../deploy/applications/penpot.release-template.json',import.meta.url)));
  const fact={pluginKey:manifest.id,authorized:true,launchable:false,lifecycleState:'enabled',
    ui:{categoryKey:manifest.ui.category,labelKey:manifest.ui.displayNameKey,
      descriptionKey:manifest.ui.summaryKey,iconKey:manifest.ui.icon,order:manifest.ui.order}};
  const groups=buildWorkbenchCatalog({categories:categoryConfiguration,
    applications:applicationsFromCatalogFacts([fact]),authorization:{permissions:['design:use']}});
  assert.equal(groups[0].key,'professional');
  assert.equal(groups[0].applications[0].runtime.launchable,false);
  const diagnostics=[];
  for(const locale of supportedLocales){
    const {translate}=createI18nRuntime({locale,onDiagnostic:v=>diagnostics.push(v)});
    assert.notEqual(translate(fact.ui.labelKey),fact.ui.labelKey);
    assert.notEqual(translate(fact.ui.descriptionKey),fact.ui.descriptionKey);
    assert.equal(searchWorkbenchCatalog(groups,translate(fact.ui.labelKey),translate)[0].pluginKey,manifest.id);
  }
  assert.deepEqual(diagnostics,[]);
  assert.deepEqual(buildWorkbenchCatalog({categories:categoryConfiguration,
    applications:applicationsFromCatalogFacts([{...fact,authorized:false}]),authorization:{permissions:['design:use']}}),[]);
});

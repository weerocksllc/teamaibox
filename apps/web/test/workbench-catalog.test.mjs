import assert from "node:assert/strict";
import { test } from "node:test";
import { categoryConfiguration } from '../src/workbench-data.ts';

import {
  applicationsFromCatalogFacts,
  buildWorkbenchCatalog,
  searchWorkbenchCatalog,
} from "../src/catalog/workbench-catalog.mjs";

const categories = [
  { key: "ai", labelKey: "category.ai", order: 20 },
  { key: "collaboration", labelKey: "category.collaboration", order: 10 },
];

test('validated plugin category names map to existing workbench groups without losing the phone entry',()=>{
  const facts=['professional-tool','ai-application'].map((categoryKey,index)=>({
    pluginKey:index?'example.ai':'official.virtual-phones',authorized:true,launchable:true,
    ui:{categoryKey,labelKey:'app.virtual-phones.name',descriptionKey:'app.virtual-phones.description',iconKey:'smartphone'},
  }));
  const apps=applicationsFromCatalogFacts(facts);
  assert.deepEqual(apps.map(v=>v.categoryKey),['professional','ai-application']);
  const groups=buildWorkbenchCatalog({categories:categoryConfiguration,applications:apps,authorization:{permissions:['phone:use']}});
  assert.equal(groups.flatMap(g=>g.applications).length,2);
});

test('all existing AI application categories remain visible with the real production category configuration',()=>{
  const keys=['assistant','drawing','ocr','asr','translation'];
  const facts=keys.map(key=>({pluginKey:'official.'+key,authorized:true,launchable:true,
    ui:{categoryKey:'ai-application',labelKey:'app.'+key+'.name',descriptionKey:'app.'+key+'.description',iconKey:'blocks'}}));
  const groups=buildWorkbenchCatalog({categories:categoryConfiguration,applications:applicationsFromCatalogFacts(facts),authorization:{permissions:[]}});
  assert.equal(groups.length,1);assert.equal(groups[0].key,'ai-application');
  assert.deepEqual(groups[0].applications.map(x=>x.pluginKey).sort(),keys.map(k=>'official.'+k).sort());
});

const applications = [
  {
    pluginKey: "official.assistant",
    categoryKey: "ai",
    labelKey: "app.assistant.name",
    descriptionKey: "app.assistant.description",
    iconKey: "sparkles",
    enabled: true,
    order: 10,
    requiredPermissions: ["ai:invoke"],
    runtime: { authorized: true, launchable: true },
  },
  {
    pluginKey: "test.professional-tool",
    categoryKey: "ai",
    labelKey: "app.professional_tool.name",
    descriptionKey: "app.professional_tool.description",
    iconKey: "flask",
    enabled: true,
    order: 20,
    requiredPermissions: ["model:manage"],
    runtime: { authorized: true, launchable: true },
  },
];

test("builds navigation from enabled plugin metadata and configured category order", () => {
  const groups = buildWorkbenchCatalog({
    categories,
    applications,
    authorization: { permissions: ["ai:invoke"] },
  });
  assert.deepEqual(groups.map((group) => group.key), ["ai"]);
  assert.deepEqual(groups[0].applications.map((app) => app.pluginKey), ["official.assistant"]);
});

test("accepts a newly configured plugin category without changing shell code", () => {
  const groups = buildWorkbenchCatalog({
    categories: [...categories, { key: "legal", labelKey: "category.legal", order: 15 }],
    applications: [...applications, {
      pluginKey: "third-party.contract-review",
      categoryKey: "legal",
      labelKey: "app.contract_review.name",
      descriptionKey: "app.contract_review.description",
      iconKey: "file-search",
      enabled: true,
      order: 1,
      requiredPermissions: ["file:read"],
      runtime: { authorized: true, launchable: true },
    }],
    authorization: { permissions: ["ai:invoke", "file:read"] },
  });
  assert.deepEqual(groups.map((group) => group.key), ["legal", "ai"]);
});

test("derives entries only from installed runtime facts and preserves truthful unavailable state", () => {
  const applications = applicationsFromCatalogFacts([{
    pluginKey: "third-party.ocr-review",
    installedVersion: "1.0.0",
    authorized: true,
    launchable: false,
    blockers: ["model_route_unavailable"],
    ui: { categoryKey: "ai", labelKey: null, descriptionKey: null, iconKey: "scan-text", order: 10, fallbackLabel: "OCR Review" },
  }]);
  const groups = buildWorkbenchCatalog({ categories, applications, authorization: { permissions: [] } });
  assert.equal(groups[0].applications[0].pluginKey, "third-party.ocr-review");
  assert.equal(groups[0].applications[0].runtime.launchable, false);
  assert.deepEqual(buildWorkbenchCatalog({ categories, applications: [], authorization: { permissions: [] } }), []);
  assert.deepEqual(searchWorkbenchCatalog(groups, "OCR Review", (key) => key).map((app) => app.pluginKey), ["third-party.ocr-review"]);
});

test("global search includes localized labels, descriptions, and plugin keys", () => {
  const groups = buildWorkbenchCatalog({
    categories,
    applications,
    authorization: { permissions: ["ai:invoke", "model:manage"] },
  });
  const messages = {
    "app.assistant.name": "AI 助手",
    "app.assistant.description": "对话与 Agent",
    "app.professional_tool.name": "专业工具",
    "app.professional_tool.description": "模型评测",
  };
  const translate = (key) => messages[key] ?? key;
  assert.deepEqual(searchWorkbenchCatalog(groups, "评测", translate).map((app) => app.pluginKey), ["test.professional-tool"]);
  assert.deepEqual(searchWorkbenchCatalog(groups, "official.assistant", translate).map((app) => app.pluginKey), ["official.assistant"]);
});

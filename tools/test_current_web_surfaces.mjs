import test from 'node:test';
import assert from 'node:assert/strict';
import { ADMINS,APPS,COMBINATIONS,issues,auditExpression,readinessExpression } from './check_current_web_surfaces.mjs';
const combination=COMBINATIONS[0];
const ok=()=>({language:combination.locale,theme:combination.theme,viewportWidth:combination.width,scrollWidth:combination.width,hostWidth:combination.width,hostScrollWidth:combination.width,unnamed:[],duplicateIds:[],imagesWithoutAlt:0,emptyHeadings:0,visibleAlertCount:0,headingContrast:8,secureContext:true});
test('covers new guest administration and applications without replacing old surfaces',()=>{assert.equal(ADMINS.length,17);assert.equal(APPS.length,10);assert.equal(COMBINATIONS.length,8);for(const key of ['phones','computers'])assert.ok(ADMINS.some(([k])=>k===key));for(const key of ['virtual-phones','virtual-computers','wireless-casting'])assert.ok(APPS.includes(key));});
test('accepts only actual matching layout and preferences',()=>{assert.deepEqual(issues(ok(),combination,false),[]);assert.deepEqual(issues({...ok(),theme:'dark'},combination,false),['preferences_not_applied']);assert.ok(issues({...ok(),scrollWidth:1500},combination,false).includes('horizontal_overflow'));});
test('does not treat denied member page as a successful admin panel',()=>{assert.ok(issues({...ok(),visibleAlertCount:1},combination,false).includes('visible_error'));assert.deepEqual(issues({...ok(),visibleAlertCount:1},combination,true),[]);});
test('does not collect input values or content in audit',()=>{const expression=auditExpression('main');assert.ok(!expression.includes('.value'));assert.ok(!expression.includes('innerHTML'));assert.ok(issues({...ok(),secureContext:false},combination,false).includes('insecure_context'));assert.ok(issues({...ok(),unnamed:[{tag:'INPUT'}]},combination,false).includes('unnamed_controls'));});
test('hidden loading skeletons do not block a loaded page',()=>{
  const expression=readinessExpression('main'),skeleton={getBoundingClientRect:()=>({width:100,height:20}),closest:()=>({hidden:true})};
  const doc={querySelector:()=>({}),querySelectorAll:()=>[skeleton]},view={getComputedStyle:()=>({visibility:'visible',display:'block'})};
  const evaluate=new Function('doc','view',expression);
  assert.equal(evaluate(doc,view).ready,true);
  skeleton.closest=()=>null;assert.equal(evaluate(doc,view).ready,false);
});
test('contrast evaluation supports CSS color-mix and alpha, not only rgb strings',()=>{
  const expression=auditExpression('main');assert.ok(expression.includes('getImageData'));
  assert.ok(expression.includes('blend(rgba'));assert.ok(!expression.includes('c.match('));
});

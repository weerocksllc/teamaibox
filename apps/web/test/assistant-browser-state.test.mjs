import test from 'node:test';
import assert from 'node:assert/strict';
import {AssistantBrowserState,projectDirectories,projectSelection,attachmentFromFile,canonicalWorkspace,assistantAccountLocation} from '../src/assistant/assistant-browser-state.ts';
import {projectSessionKeys,projectSessionText,projectFeedbackKeys,projectFeedbackText,projectImportLimitText} from '../src/assistant/project-session-copy.ts';
import {supportedLocaleCodes} from '../../../packages/ui-system/src/locale-registry.mjs';
const storage=()=>{const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};};
const a={directory:'/workspace/alpha',sessionId:'ses_a'},b={directory:'/workspace/beta',sessionId:'ses_b'};
test('drafts remain separate by user, directory and native session including new',()=>{
  const disk=storage(),state=new AssistantBrowserState('synthetic-a',disk);
  state.update(a,{text:'first',agent:'build',attachments:[attachmentFromFile(new File(['text'],'note.txt'))]});
  state.update(b,{text:'second'});state.update({...a,sessionId:null},{text:'new'});
  assert.equal(state.get(a).text,'first');assert.equal(state.get(a).attachments[0].file.name,'note.txt');
  assert.equal(state.get(b).text,'second');assert.equal(state.get({...a,sessionId:null}).text,'new');
  const restored=new AssistantBrowserState('synthetic-a',disk);assert.equal(restored.get(a).text,'first');assert.equal(restored.get(a).agent,'build');assert.equal(restored.get(a).attachments[0].file,undefined);
  assert.equal(new AssistantBrowserState('synthetic-b',disk).get(a).text,'');assert.equal(new AssistantBrowserState('',disk).get(a).text,'');
});
test('another tab never silently overwrites stored changes, memory is retained',()=>{
  const disk=storage(),one=new AssistantBrowserState('synthetic',disk),two=new AssistantBrowserState('synthetic',disk);
  one.get(a);two.get(a);one.update(a,{text:'from first tab'});two.update(a,{text:'second tab text'});
  assert.equal(two.notice,'conflict');assert.equal(two.get(a).text,'second tab text');assert.equal(new AssistantBrowserState('synthetic',disk).get(a).text,'from first tab');
});
test('storage failure does not discard input and a new session retains text typed after send',()=>{
  const state=new AssistantBrowserState('synthetic',{getItem(){return null;},setItem(){throw Error('full');},removeItem(){}});
  state.update({...a,sessionId:null},{text:'typed while creating',model:'provider\nmodel'});assert.equal(state.notice,'unavailable');
  assert.equal(state.move({...a,sessionId:null},a),true);assert.equal(state.get(a).text,'typed while creating');
  state.update(a,{text:'newer'});assert.equal(state.move(b,a),false);assert.equal(state.get(a).text,'newer');
});
test('project discovery uses directories even if upstream project IDs are shared',()=>{
  assert.deepEqual(projectDirectories([{id:'global',worktree:'/workspace/alpha'},{id:'global',worktree:'/workspace/beta'}],[{directory:'/workspace/alpha/'}],[]),['/workspace/alpha','/workspace/beta']);
  assert.equal(canonicalWorkspace('/workspace/alpha/'),'/workspace/alpha');assert.equal(canonicalWorkspace('/workspace/../other'),null);
  const state=new AssistantBrowserState('synthetic',storage());state.remember(a);state.remember(b);state.remember({...a,sessionId:null});assert.equal(state.recent().length,2);assert.equal(state.recent()[0].sessionId,null);
});
test('new project/session labels cover every existing UI language without missing keys',()=>{
  for(const locale of supportedLocaleCodes){for(const key of projectSessionKeys)assert.ok(projectSessionText(locale,key)?.trim(),`${locale}:${key}`);for(const key of projectFeedbackKeys)assert.ok(projectFeedbackText(locale,key)?.trim(),`${locale}:${key}`);assert.ok(projectImportLimitText(locale)?.includes('100'));}
});
test('a different authenticated user does not inherit the previous user URL context',()=>{
  const url=new URL('https://example.test/apps/assistant?assistantDirectory=/workspace/alpha&assistantSession=ses_a&theme=dark');
  assert.equal(assistantAccountLocation(url,'one','two').search,'?theme=dark');assert.equal(assistantAccountLocation(url,'one','one').href,url.href);assert.equal(assistantAccountLocation(url,null,'one').href,url.href);
});
test('unvisited projects open an existing session but explicit new drafts keep their selection',()=>{
  const sessions=[{directory:'/workspace/alpha',id:'ses_latest'}];
  assert.equal(projectSelection('/workspace/alpha',[],sessions).sessionId,'ses_latest');
  assert.equal(projectSelection('/workspace/alpha',[{directory:'/workspace/alpha',sessionId:null}],sessions).sessionId,null);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=name=>readFileSync(new URL('../src/'+name,import.meta.url),'utf8');

test('shared inline editor focuses a field, supports Escape and prevents changes while submitting',()=>{
  const source=read('InlineEditor.tsx');
  assert.match(source,/<EditorDialog[^>]+busy=\{busy\} onCancel=\{onCancel\}/);
  const dialog=read('EditorDialog.tsx');
  assert.match(dialog,/node.showModal\(\)/);
  assert.match(dialog,/const firstField = body\?\.querySelector/);
  assert.match(dialog,/if \(event.key === "Escape"\) event.stopPropagation\(\)/);
  assert.match(dialog,/event.preventDefault\(\); if \(!busy\) onCancel\(\)/);
  assert.match(source,/<fieldset[^>]+disabled=\{busy\}/);
  assert.match(source,/<button[^>]+disabled=\{busy\} onClick=\{onCancel\}/);
});

test('storage refresh and errors do not unmount existing drafts',()=>{
  const source=read('storage/StorageAdministrationPanel.tsx');
  assert.match(source,/\{data && <>/);
  assert.doesNotMatch(source,/state === "error" \?/);
  assert.match(source,/if \(refreshing.current\) return/);
  assert.match(source,/<InlineEditor[^>]+busy=\{busy\}/);
});

test('failed plugin import does not close or erase its form',()=>{
  const source=read('plugins/PluginAdministrationPanel.tsx');
  assert.match(source,/await importPlugin\(input\); setComposer\(false\)/);
  assert.doesNotMatch(source,/\.then\(\(\) => \{ form.reset\(\)/);
  assert.match(source,/<InlineEditor[^>]+busy=\{busy !== null\}/);
});

test('provider forms can cancel and credential fields reset only after acknowledged success',()=>{
  const source=read('providers/ExternalProvidersPanel.tsx');
  assert.equal((source.match(/<InlineEditor/g)||[]).length,2);
  assert.match(source,/await rotateExternalProviderCredential\(provider, String\(form.get\("credential"\)\)\); element.reset\(\)/);
});

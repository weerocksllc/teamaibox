import test from 'node:test';
import assert from 'node:assert/strict';
import {isNativeWorkspace,nativeResultPath} from '../src/assistant/native-workspace-path.ts';
import {nativeProjectText,nativeProjectKeys} from '../src/assistant/native-project-copy.ts';
import {supportedLocaleCodes} from '../../../packages/ui-system/src/locale-registry.mjs';
import {nativeSettingsText,nativeSettingsKeys} from '../src/assistant/native-settings-copy.ts';
import {nativeTransferText,nativeTransferKeys} from '../src/assistant/native-transfer-copy.ts';
import {nativeWorktreeText,nativeWorktreeKeys} from '../src/assistant/native-worktree-copy.ts';

test('project navigation stays within container workspace',()=>{
  for(const path of ['/workspace','/workspace/My project','/workspace/日本語'])assert.equal(isNativeWorkspace(path),true);
  for(const path of ['/','/workspace-other','/workspace/../private','/workspace/./x','/workspace/\\x','/workspace/\n'])assert.equal(isNativeWorkspace(path),false);
});
test('native search paths normalize only the selected workspace',()=>{
  assert.equal(nativeResultPath('/workspace/demo/a.txt','/workspace/demo'),'a.txt');
  assert.equal(nativeResultPath('./notes/a.txt','/workspace/demo'),'notes/a.txt');
  for(const path of ['/workspace/other/a.txt','../a.txt','a/../../b','a\\b','a\0b',''])assert.equal(nativeResultPath(path,'/workspace/demo'),null);
});
test('project and search controls have labels in every product language',()=>{
  for(const locale of supportedLocaleCodes)for(const key of nativeProjectKeys)assert.ok(nativeProjectText(locale,key)?.trim(),`${locale}:${key}`);
  for(const locale of supportedLocaleCodes)for(const key of nativeSettingsKeys)assert.ok(nativeSettingsText(locale,key)?.trim(),`${locale}:${key}`);
  for(const locale of supportedLocaleCodes)for(const key of nativeTransferKeys)assert.ok(nativeTransferText(locale,key)?.trim(),`${locale}:${key}`);
  for(const locale of supportedLocaleCodes)for(const key of nativeWorktreeKeys)assert.ok(nativeWorktreeText(locale,key)?.trim(),`${locale}:${key}`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {supportedLocaleCodes} from '../../../packages/ui-system/src/locale-registry.mjs';
import {nativeProjectSettingsText} from '../src/assistant/native-project-settings-copy.ts';
import {nativeCatalogText} from '../src/assistant/native-catalog-copy.ts';
import {nativeShellText} from '../src/assistant/native-shell-copy.ts';
import {nativeGitText} from '../src/assistant/native-git-copy.ts';
import {nativeHistoryEditText} from '../src/assistant/native-history-edit-copy.ts';
import {nativeSessionText} from '../src/assistant/native-session-copy.ts';

test('project config, discovery and shell controls cover every product language',()=>{
  for(const locale of supportedLocaleCodes){
    for(const key of ['edit','gitRequired','source','saved','reload','reloadBlocked','loaded','warning'])assert.ok(nativeProjectSettingsText(locale,key)?.trim(),`${locale}:${key}`);
    for(const key of ['catalog','tools','resources','parameters','empty','capabilities'])assert.ok(nativeCatalogText(locale,key)?.trim(),`${locale}:${key}`);
    for(const key of ['title','run','notice','selectAgent'])assert.ok(nativeShellText(locale,key)?.trim(),`${locale}:${key}`);
    for(const key of ['title','working','branch','refresh','empty','gitRequired','unavailable'])assert.ok(nativeGitText(locale,key)?.trim(),`${locale}:${key}`);
    for(const key of ['manage','part','edit','deletePart','deleteMessage','warning','confirm','cancel','conflict','shell','defaultShell'])assert.ok(nativeHistoryEditText(locale,key)?.trim(),`${locale}:${key}`);
    for(const key of ['browse','search','all','current','archived','more','empty','paths','queued','patch'])assert.ok(nativeSessionText(locale,key)?.trim(),`${locale}:${key}`);
  }
});

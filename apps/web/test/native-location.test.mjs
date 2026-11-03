import test from 'node:test';
import assert from 'node:assert/strict';
import {readNativeLocation,writeNativeLocation} from '../src/assistant/native-location.ts';
test('workspace and native session survive deep links without storing credentials or another owner',()=>{
  const url=writeNativeLocation(new URL('https://example.test/apps/assistant'), 'ses_example', '/workspace/project a');
  assert.deepEqual(readNativeLocation(url),{directory:'/workspace/project a',sessionId:'ses_example'});
  assert.equal(writeNativeLocation(url,null,'/workspace').search,'');
  for(const path of ['/etc','/workspace/../other','/workspace\\other','/workspace/./a']){
    url.searchParams.set('assistantDirectory',path);assert.equal(readNativeLocation(url).directory,'/workspace');
  }
  url.searchParams.set('assistantSession','other/session');assert.equal(readNativeLocation(url).sessionId,null);
});

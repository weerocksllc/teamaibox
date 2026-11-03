import test from 'node:test';
import assert from 'node:assert/strict';
import {visibleNativeMessages} from '../src/assistant/native-history.ts';
const messages=[{info:{id:'a'},parts:[{id:'one'},{id:'two'}]},{info:{id:'b'},parts:[{id:'three'}]}];
test('native revert hides the reverted range without changing stored records',()=>{
  const original=JSON.stringify(messages);
  assert.deepEqual(visibleNativeMessages(messages,{messageID:'b'}),[messages[0]]);
  assert.deepEqual(visibleNativeMessages(messages,{messageID:'a',partID:'two'}),[{...messages[0],parts:[{id:'one'}]}]);
  assert.equal(JSON.stringify(messages),original);
  assert.equal(visibleNativeMessages(messages),messages);
  assert.equal(visibleNativeMessages(messages,{messageID:'not-loaded'}),messages);
});

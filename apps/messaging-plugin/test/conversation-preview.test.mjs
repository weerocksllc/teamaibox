import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {conversationPreview} from '../src/public/conversation-preview.mjs';
test('unloaded history is not reported as empty and needs no per-conversation history fetch',()=>{
  const t=key=>key;
  assert.equal(conversationPreview({last_message_sequence:3},null,t),'openMessages');
  assert.equal(conversationPreview({lastMessageSequence:3},null,t),'openMessages');
  assert.equal(conversationPreview({lastMessageSequence:0},null,t),'noMessages');
  assert.equal(conversationPreview({}, {content:'hello'},t),'hello');
  assert.equal(conversationPreview({}, {attachments:[{filename:'test.txt'}]},t),'attachment');
});
test('read acknowledgement covers own latest message and avoids older/search/background reads',async()=>{
  const s=await readFile(new URL('../src/public/app.js',import.meta.url),'utf8');
  assert.match(s,/!older&&!focus&&latest&&!document.hidden\)void markRead\(latest\)/);
  assert.match(s,/lastRead\(conversation\)>=message.sequence/);
  assert.match(s,/Math.max\(lastRead\(current\),message.sequence\)/);
  assert.match(s,/pendingRead.delete\(message.id\)/);
  assert.match(s,/preview.textContent=conversationPreview\(item,latestMessage\(item.id\),text\)/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageHistory } from '../src/public/message-history.mjs';
test('cleaned history does not offer nonexistent older messages and invalidation drops cached content',async()=>{
 let messages=[{id:'old',sequence:36}];const history=new MessageHistory(async()=>({data:messages}));
 await history.refresh('chat');assert.equal(history.get('chat').hasOlder,false);
 messages=[{id:'new',sequence:37}];await history.invalidate('chat');await history.refresh('chat');
 assert.deepEqual(history.get('chat').messages,messages);assert.equal(history.get('chat').hasOlder,false);
});

function fixture(count) {
  const messages = Array.from({ length: count }, (_, index) => ({ id: `message-${index + 1}`, sequence: index + 1, content: String(index) }));
  const requests = [];
  const history = new MessageHistory(async path => {
    const q = new URL(path, 'https://box.invalid').searchParams;
    requests.push(path);
    const data = q.has('before') ? messages.filter(item => item.sequence < Number(q.get('before'))).slice(-100)
      : messages.filter(item => item.sequence > Number(q.get('after'))).slice(0, 100);
    return { data };
  });
  return { history, messages, requests };
}

test('latest messages remain visible beyond 500; all older pages remain accessible', async () => {
  const { history, requests } = fixture(1207);
  const first = await history.refresh('conversation');
  assert.equal(first.messages[0].sequence, 1108);
  assert.equal(first.messages.at(-1).sequence, 1207);
  assert.equal(requests.length, 1);
  while (history.get('conversation').hasOlder) await history.older('conversation');
  assert.deepEqual(history.get('conversation').messages.map(item => item.sequence), Array.from({ length: 1207 }, (_, i) => i + 1));
});

test('reconnect catches up across page boundaries and overlapping refreshes do not duplicate', async () => {
  const { history, messages } = fixture(80);
  await history.refresh('conversation');
  for (let i = 81; i <= 730; i++) messages.push({ id: `message-${i}`, sequence: i });
  await Promise.all([history.refresh('conversation'), history.refresh('conversation')]);
  assert.equal(history.get('conversation').messages.length, 730);
  assert.equal(history.get('conversation').messages.at(-1).sequence, 730);
});

test('old search result is read directly without fetching intervening history', async () => {
  const { history, messages, requests } = fixture(2207);
  const result = await history.focus('conversation', messages[399]);
  assert.equal(requests.length, 2);
  assert.equal(result.messages.at(-1).sequence, 400);
  assert.equal(result.hasOlder, true);
});

test('stalled cursor rejects rather than looping forever', async () => {
  const history = new MessageHistory(async () => ({ data: Array.from({ length: 100 }, (_, i) => ({ id: `m${i}`, sequence: i + 1 })) }));
  await history.refresh('conversation');
  await assert.rejects(history.refresh('conversation'), /did not advance/);
});

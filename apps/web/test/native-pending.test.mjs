import test from 'node:test';
import assert from 'node:assert/strict';
import {nativePendingMessages} from '../src/assistant/native-pending.ts';
const message=(id,role,completed)=>({info:{id,role,time:{created:1,...(completed===undefined?{}:{completed})}},parts:[]});
test('queued hint projects native history after the current unfinished response',()=>{
  const history=[message('u1','user'),message('a1','assistant',2),message('u2','user'),message('a2','assistant'),message('u3','user'),message('u4','user')];
  assert.deepEqual([...nativePendingMessages(history)],['u3','u4']);assert.equal(history.length,6);
  assert.deepEqual([...nativePendingMessages([...history,message('a3','assistant',3)])],[]);
});
test('idle or user-only histories are not invented queues',()=>{
  assert.equal(nativePendingMessages([message('u','user')]).size,0);assert.equal(nativePendingMessages([message('u','user'),message('a','assistant',0)]).size,0);
});

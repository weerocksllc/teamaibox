import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeClient} from '../src/assistant/native-client.ts';
import {nativeText,nativeCopyKeys} from '../src/assistant/native-copy.ts';
import {decodeTerminalFrame} from '../src/assistant/native-terminal-protocol.ts';
import {supportedLocaleCodes} from '../../../packages/ui-system/src/locale-registry.mjs';

function browser(t,fetchImplementation) {
  const saved=new Map(['window','document','fetch','EventSource','WebSocket'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]));
  t.after(()=>{for(const[k,v]of saved){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k];}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{origin:'https://appliance.test'}}});
  Object.defineProperty(globalThis,'document',{configurable:true,value:{cookie:'__Host-teamaibox-csrf=synthetic'}});
  globalThis.fetch=fetchImplementation;
}
test('native requests preserve their original session and send once',async t=>{
  const calls=[];browser(t,async(url,init)=>{calls.push({url,init});return new Response(null,{status:204});});
  const client=createNativeClient();
  await client.request('/session/ses_synthetic/prompt_async',{method:'POST',directory:'/workspace/project',body:{parts:[{type:'text',text:'synthetic'}]}});
  assert.equal(calls.length,1);assert.equal(calls[0].url.pathname,'/api/v1/assistant/native/session/ses_synthetic/prompt_async');
  assert.equal(calls[0].url.searchParams.get('directory'),'/workspace/project');
  assert.equal(calls[0].init.headers['x-csrf-token'],'synthetic');
  assert.equal(calls[0].init.credentials,'same-origin');assert.equal(calls[0].init.redirect,'error');
  client.close();assert.equal(calls[0].init.signal.aborted,true);
});
test('lost acknowledgement does not automatically repeat a prompt',async t=>{
  let count=0;browser(t,async()=>{count++;throw new TypeError('network');});
  await assert.rejects(createNativeClient().request('/session/ses_synthetic/prompt_async',{method:'POST',body:{parts:[]}}));
  assert.equal(count,1);
});
test('native session pages omit workspace only for owner-wide discovery and preserve the cursor',async t=>{
  const urls=[];browser(t,async url=>{urls.push(url);return Response.json([],{headers:{'x-next-cursor':'1790000000000'}});});const client=createNativeClient();
  const page=await client.sessionPage(new URLSearchParams({limit:'50',search:'synthetic'}));assert.equal(urls[0].searchParams.has('directory'),false);assert.equal(page.cursor,'1790000000000');
  await client.sessionPage(new URLSearchParams({cursor:page.cursor}),'/workspace/project');assert.equal(urls[1].searchParams.get('directory'),'/workspace/project');
});
test('native patch download returns exact text, never a JSON preview',async t=>{
  browser(t,async(url,init)=>{assert.ok(url.pathname.endsWith('/vcs/diff/raw'));assert.equal(url.searchParams.get('directory'),'/workspace/project');assert.equal(init.headers.accept,'text/x-diff');return new Response('  patch\n\n');});
  assert.equal(await createNativeClient().readPatch('/workspace/project'),'  patch\n\n');
});
test('editable native file reads preserve whitespace and use owner-scoped raw route',async t=>{
  browser(t,async(url,init)=>{
    assert.equal(url.pathname,'/api/v1/assistant/native/api/fs/read/notes/%E6%97%A5%20one.txt');
    assert.equal(url.searchParams.get('directory'),'/workspace/project');
    assert.equal(init.redirect,'error');return new Response('  text\r\n\n');
  });
  const client=createNativeClient();assert.equal(await client.readText('notes/日 one.txt','/workspace/project'),'  text\r\n\n');
  await assert.rejects(client.readText('../secrets','/workspace/project'));
});
test('React effect replay creates a fresh lifetime without reviving old requests',async t=>{
  const signals=[];browser(t,async(_,init)=>{signals.push(init.signal);return Response.json([]);});
  const client=createNativeClient();await client.request('/session');client.close();client.activate();await client.request('/session');
  assert.equal(signals[0].aborted,true);assert.equal(signals[1].aborted,false);assert.notEqual(signals[0],signals[1]);client.close();
});
test('closing a user client closes its SSE stream; event handling never resubmits',t=>{
  let calls=0;browser(t,async()=>{calls++;return Response.json([]);});let stream;
  globalThis.EventSource=class {constructor(url){this.url=url;stream=this;this.closed=false;}close(){this.closed=true;}};
  const client=createNativeClient(),events=[],connection=[];
  const detach=client.events('/workspace/demo',v=>events.push(v),v=>connection.push(v));
  stream.onopen();stream.onmessage({data:'{"type":"permission.asked","properties":{"id":"per_synthetic"}}'});stream.onerror();
  assert.equal(events[0].properties.id,'per_synthetic');assert.deepEqual(connection,[true,false]);assert.equal(calls,0);
  client.close();assert.equal(stream.closed,true);detach();
});
test('new product-owned labels cover every supported locale',()=>{
  for(const locale of supportedLocaleCodes)for(const key of nativeCopyKeys)assert.ok(nativeText(locale,key)?.trim(),`${locale}:${key}`);
});
test('terminal ticket stays on same-origin native path and sign-out closes it',t=>{
  browser(t,async()=>Response.json({}));let socket;
  globalThis.WebSocket=class extends EventTarget {constructor(url){super();this.url=url;socket=this;}close(){this.closed=true;this.dispatchEvent(new Event('close'));}};
  const client=createNativeClient();client.terminal('pty_synthetic','one-use-ticket','/workspace/demo',42);
  assert.equal(socket.url.origin,'wss://appliance.test');assert.equal(socket.url.pathname,'/api/v1/assistant/native/pty/pty_synthetic/connect');
  assert.equal(socket.url.searchParams.get('cursor'),'42');assert.equal(socket.url.searchParams.get('ticket'),'one-use-ticket');
  client.close();assert.equal(socket.closed,true);assert.throws(()=>client.terminal('pty_synthetic','unused','/workspace'),{name:'AbortError'});
});
test('retained native CLI output uses canonical PTY route in the same workspace',t=>{
  browser(t,async()=>Response.json({}));let socket;
  globalThis.WebSocket=class extends EventTarget {constructor(url){super();this.url=url;socket=this;}close(){this.dispatchEvent(new Event('close'));}};
  const client=createNativeClient();client.terminal('pty_synthetic','one-use-ticket','/workspace/demo',0,'/api/pty');
  assert.equal(socket.url.pathname,'/api/v1/assistant/native/api/pty/pty_synthetic/connect');
  assert.equal(socket.url.searchParams.get('directory'),'/workspace/demo');client.close();
});
test('native terminal metadata is not rendered as output and cursor uses native units',()=>{
  const frame=new TextEncoder().encode('\0{"cursor":17}').buffer;
  assert.deepEqual(decodeTerminalFrame(frame),{cursor:17});
  const text='hello 🎉';assert.deepEqual(decodeTerminalFrame(text),{text});
  assert.equal(text.length,8);
  assert.throws(()=>decodeTerminalFrame(new TextEncoder().encode('\0{"cursor":-1}').buffer));
});

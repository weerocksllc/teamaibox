import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import {createHash} from 'node:crypto';
import { createNativeTransport, nativeRequestTarget, forwardNativeResponse, nativeContract } from '../src/opencode-native-transport.mjs';

test('candidate contract pins native HTTP only and retains the complete endpoint inventory', () => {
  assert.equal(nativeContract.version, '1.19.5');
  assert.equal(nativeContract.operations.length, 188);
  for (const operation of ['session.prompt_async', 'mcp.auth.callback', 'pty.connect', 'v2.session.context', 'app.skills']) {
    assert.ok(nativeContract.operations.some(value => value.operation === operation));
  }
});
test('native workspace and endpoint scope is checked before URL normalization', () => {
  assert.equal(nativeRequestTarget('POST', '/session/ses_abc/prompt_async').operation, 'session.prompt_async');
  assert.equal(nativeRequestTarget('GET', '/event?directory=%2Fworkspace%2Fdemo').path, '/event?directory=%2Fworkspace%2Fdemo');
  for (const path of ['//evil.invalid/session', '/session/../event', '/session/%2e%2e/event', '/session%2Fevil', '/event#fragment', '/event?directory=/etc', '/event?directory=/workspace/../etc', '/event?directory=/workspace&directory=/workspace', '/event?server=evil', '/event?workspace=other']) {
    assert.throws(() => nativeRequestTarget('GET', path));
  }
  for (const path of ['/global/upgrade', '/global/dispose', '/tui/submit-prompt', '/sync/steal', '/experimental/control-plane/move-session']) {
    assert.throws(() => nativeRequestTarget('POST', path), { code: 'assistant_native_route_unavailable' });
  }
});
test('native raw file paths allow encoded filenames but not traversal or double encoding',()=>{
  assert.equal(nativeRequestTarget('GET','/api/fs/read/notes/%E6%97%A5%20one.txt').operation,'v2.fs.read');
  for(const path of ['../secret','%2e%2e/secret','a/%2e%2e/secret','%252e%252e/secret','%2fetc/passwd','a//b','a%5cb','a%00b'])assert.throws(()=>nativeRequestTarget('GET','/api/fs/read/'+path));
  assert.throws(()=>nativeRequestTarget('GET','/api/fs/list?location[directory]=/etc'));
  assert.throws(()=>nativeRequestTarget('GET','/api/fs/list?location[workspace]=other'));
});
test('owner-wide session discovery preserves native directory omission but validates explicit filters',()=>{
  assert.equal(nativeRequestTarget('GET','/experimental/session?limit=50').path,'/experimental/session?limit=50');
  assert.equal(nativeRequestTarget('GET','/experimental/session?directory=/workspace/demo').directory,'/workspace/demo');
  assert.throws(()=>nativeRequestTarget('GET','/experimental/session?directory=/etc'));
  assert.match(nativeRequestTarget('GET','/session').path,/directory=%2Fworkspace/);
});
test('native session pagination cursor passes through without forwarding private headers',async t=>{
  const server=http.createServer((req,res)=>void forwardNativeResponse(new Response('[]',{headers:{'x-next-cursor':'1790000000000','set-cookie':'not-forwarded=1'}}),res));
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const response=await fetch(`http://127.0.0.1:${server.address().port}`);assert.equal(response.headers.get('x-next-cursor'),'1790000000000');assert.equal(response.headers.get('set-cookie'),null);
});
test('v2 file and session operations bind their native location to the validated workspace',async()=>{
  const transport=createNativeTransport({origin:'http://native.invalid',authorization:async()=> 'Bearer synthetic',fetchImplementation:async(url,init)=>{
    assert.equal(new URL(url).searchParams.get('directory'),'/workspace/project');
    assert.equal(init.headers['x-opencode-directory'],'%2Fworkspace%2Fproject');return new Response('  original\n');
  }});
  assert.equal(await (await transport.request('GET','/api/fs/read/example.txt?directory=/workspace/project')).text(),'  original\n');
});
test('transport retains native body and never retries an uncertain prompt', async () => {
  let calls = 0;
  const transport = createNativeTransport({origin: 'http://user-container:4097', prefix: '/native', authorization: async () => 'Bearer synthetic',
    fetchImplementation: async (url, init) => {
      calls++;
      assert.equal(url, 'http://user-container:4097/native/session/ses_demo/prompt_async?directory=%2Fworkspace');
      assert.equal(init.body, '{"parts":[{"type":"text","text":"hello"}]}');
      assert.equal(init.redirect, 'manual');
      assert.equal(init.headers.authorization, 'Bearer synthetic');
      throw new Error('private upstream detail');
    }});
  await assert.rejects(transport.request('POST', '/session/ses_demo/prompt_async', {body: '{"parts":[{"type":"text","text":"hello"}]}'}), error => {
    assert.equal(error.code, 'assistant_native_unavailable'); assert.equal(error.cause, undefined); return true;
  });
  assert.equal(calls, 1);
});
test('SSE frames pass through unchanged and private headers are stripped', async t => {
  const frames = 'data: {"type":"message.part.updated","properties":{"delta":"hi"}}\n\n';
  const server = http.createServer((req, res) => void forwardNativeResponse(new Response(frames, {
    headers: {'content-type':'text/event-stream','set-cookie':'private=synthetic','www-authenticate':'Basic private'},
  }), res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await response.text(), frames);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('www-authenticate'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
test('upstream redirects are not exposed to the browser', async () => {
  await assert.rejects(forwardNativeResponse(new Response(null, {status:302, headers:{location:'http://private-container'}}), {}), {code:'assistant_native_redirect_rejected'});
});

test('native terminal forwards only the PTY handshake and closes on logout', async t=>{
  const peers=new Set();let seen;
  const native=http.createServer();
  native.on('upgrade',(req,socket)=>{
    seen=req;peers.add(socket);socket.on('error',()=>{});
    const accept=createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nSet-Cookie: private=not-forwarded\r\n\r\n`);
    socket.write(Buffer.from([0x81,2,0x6f,0x6b]));
  });
  native.listen(0,'127.0.0.1');await once(native,'listening');
  const transport=createNativeTransport({origin:`http://127.0.0.1:${native.address().port}`,authorization:async()=> 'Bearer synthetic-native'});
  const controller=new AbortController();let forwarding;
  const proxy=http.createServer();proxy.on('upgrade',(req,socket,head)=>{
    forwarding=transport.upgrade(req.url,req,socket,head,{signal:controller.signal});
  });
  proxy.listen(0,'127.0.0.1');await once(proxy,'listening');
  t.after(()=>{controller.abort();for(const peer of peers)peer.destroy();native.close();proxy.close();});
  const ws=new WebSocket(`ws://127.0.0.1:${proxy.address().port}/pty/pty_test/connect?token=native-ticket`);
  const message=await new Promise((resolve,reject)=>{ws.onmessage=e=>resolve(e.data);ws.onerror=reject;});
  assert.equal(message,'ok');assert.equal(seen.headers.authorization,'Bearer synthetic-native');
  assert.equal(seen.headers.cookie,undefined);assert.match(seen.url,/directory=%2Fworkspace/);
  const closed=new Promise(resolve=>ws.onclose=resolve);controller.abort();await closed;await forwarding;
});

test('terminal transport rejects non-terminal routes and invalid handshake before connecting',async()=>{
  const transport=createNativeTransport({origin:'http://127.0.0.1:1',authorization:async()=> 'Bearer synthetic'});
  await assert.rejects(transport.upgrade('/event',{headers:{}},{},Buffer.alloc(0)),{code:'assistant_native_socket_invalid'});
  await assert.rejects(transport.upgrade('/pty/pty_test/connect',{headers:{upgrade:'websocket','sec-websocket-version':'13','sec-websocket-key':'bad'}},{},Buffer.alloc(0)),{code:'assistant_native_socket_invalid'});
});

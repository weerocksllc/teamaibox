import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { GuacamoleDesktopProvider } from '../src/virtual-computers/guacamole-desktop-provider.mjs';

test('adapter obtains fresh server-selected authorization and preserves display/audio capabilities', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  t.after(() => { for (const ws of server.clients) ws.terminate(); server.close(); });
  const received = [];
  server.on('connection', (ws, req) => {
    received.push(new URL(req.url, 'http://localhost').searchParams);
    ws.on('message', (data, binary) => ws.send(data, { binary }));
  });
  let issued = 0;
  const computer = { id: 'owned-computer', runId: 'current-runtime' };
  const provider = new GuacamoleDesktopProvider({ backendForComputer: async ({ computer: selected }) => {
    assert.equal(selected, computer);
    return { tunnelUrl: `ws://127.0.0.1:${server.address().port}/guacamole/websocket-tunnel`,
      issueSession: async () => ({ authToken: `fresh-${++issued}`, connectionId: 'server-selected', dataSource: 'json' }) };
  } });
  const capabilities = new URLSearchParams({ GUAC_WIDTH: '1800', GUAC_HEIGHT: '1041', GUAC_DPI: '96', GUAC_TYPE: 'c' });
  capabilities.append('GUAC_AUDIO', 'audio/L16;rate=44100,channels=2');
  for (let i = 1; i <= 2; i++) {
    const abort = new AbortController();
    const ws = await provider.connect({ computer, capabilities, signal: abort.signal });
    ws.resume();
    assert.equal(received[i - 1].get('token'), `fresh-${i}`);
    assert.equal(received[i - 1].get('GUAC_ID'), 'server-selected');
    assert.equal(received[i - 1].get('GUAC_WIDTH'), '1800');
    assert.equal(received[i - 1].get('GUAC_AUDIO'), capabilities.get('GUAC_AUDIO'));
    const echo = once(ws, 'message'); ws.send('4.sync,1.1;');
    assert.equal((await echo)[0].toString(), '4.sync,1.1;');
    const closed = once(ws, 'close'); abort.abort(); await closed;
  }
  assert.equal(capabilities.has('token'), false);
});

test('adapter rejects unencrypted remote destinations and embedded credentials before opening a socket', async () => {
  for (const tunnelUrl of ['ws://10.64.0.23:8080/tunnel', 'http://127.0.0.1/tunnel',
    'ws://user:password@127.0.0.1/tunnel', 'ws://127.0.0.1/tunnel?token=old', 'ws://127.0.0.1/tunnel#fragment']) {
    const provider = new GuacamoleDesktopProvider({ backendForComputer: async () => ({ tunnelUrl,
      issueSession: async () => ({ authToken: 'token', connectionId: 'owned', dataSource: 'json' }) }) });
    await assert.rejects(provider.connect({ computer: {}, capabilities: new URLSearchParams(), signal: new AbortController().signal }),
      { message: 'Desktop transport must be encrypted or loopback' });
  }
});

test('cancelled or invalid bootstrap cannot open a desktop connection', async () => {
  for (const invalid of [true, false]) {
    const abort = new AbortController(); if (!invalid) abort.abort();
    const provider = new GuacamoleDesktopProvider({ backendForComputer: async () => ({
      tunnelUrl: 'ws://127.0.0.1:1/tunnel', issueSession: async () => ({ authToken: 'token', connectionId: 'owned', dataSource: invalid ? 'other' : 'json' }),
    }) });
    await assert.rejects(provider.connect({ computer: {}, capabilities: new URLSearchParams(), signal: abort.signal }),
      { message: 'Desktop backend unavailable' });
  }
});

test('failed bootstrap releases the backend listener and cannot leave an RDP forward behind',async()=>{
  let closed=0,selected;
  const provider=new GuacamoleDesktopProvider({backendForComputer:async({kind})=>{selected=kind;return {close(){closed++;},issueSession:async()=>{throw Error('unavailable');}};}});
  await assert.rejects(provider.connect({computer:{},capabilities:new URLSearchParams(),kind:'console',signal:new AbortController().signal}));
  assert.equal(selected,'console');assert.equal(closed,1);
});

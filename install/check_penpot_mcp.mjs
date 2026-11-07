// Run inside the isolated source-built pilot, with --network=none and no mounts.
// This checks the real server and native image library, not editor authorization.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import sharp from 'sharp';

const child = spawn(process.execPath, ['dist/index.js', '--multi-user'], {
  env: { ...process.env, PENPOT_MCP_SERVER_HOST: '127.0.0.1' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const client = new Client({ name: 'source-pilot-check', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4401/mcp'));
try {
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    assert.equal(child.exitCode, null, 'server exited before readiness');
    try {
      const response = await fetch('http://127.0.0.1:4401/mcp', { signal: AbortSignal.timeout(500) });
      await response.body?.cancel();
      ready = true;
      break;
    } catch { await delay(100); }
  }
  assert.ok(ready, 'server did not start');
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'execute_code'), 'official execute_code missing');
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#246744' } }).png().toBuffer();
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 2);
  const sockets = (await readFile('/proc/net/tcp', 'utf8')).trim().split('\n').slice(1)
    .map(line => line.trim().split(/\s+/)).filter(fields => fields[3] === '0A');
  for (const port of [4401, 4402]) {
    const match = sockets.find(fields => parseInt(fields[1].split(':')[1], 16) === port);
    assert.ok(match, `missing listener ${port}`);
    assert.equal(match[1].split(':')[0], '0100007F', `listener ${port} is not loopback-only`);
  }
  assert.ok(!sockets.some(fields => parseInt(fields[1].split(':')[1], 16) === 4403), 'debug REPL exposed');
  console.log(JSON.stringify({ status: 'pilot-runtime-passed', architecture: process.arch,
    toolNames: tools.map(tool => tool.name), nativePng: true, loopbackOnly: true,
    editorAndAuthorizationAccepted: false }));
} finally {
  await client.close().catch(() => {});
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(5000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

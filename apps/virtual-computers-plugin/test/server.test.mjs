import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createVirtualComputersPluginServer} from '../src/server.mjs';
import {manifestPayloadDigest,validatePluginManifest} from '../../../services/plugin-runtime/src/manifest-validator.mjs';

test('computer page and recovery assets use the existing static server, without catalog regeneration',async()=>{
  const server=createVirtualComputersPluginServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try{
    const health=await(await fetch(base+'/health/ready')).json();assert.equal(health.pluginId,'official.virtual-computers');
    // The real workspace embeds the manifest path without a trailing slash.
    // Verify browser URL resolution, not just individual asset existence.
    for(const suffix of ['', '/', '/index.html', '?locale=zh-CN&theme=light']) {
      const entry=base+'/plugins/official.virtual-computers'+suffix;
      const html=await(await fetch(entry)).text();
      for(const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        const asset=new URL(match[1],entry);
        assert.ok(asset.pathname.startsWith('/plugins/official.virtual-computers/'),asset.href);
        assert.equal((await fetch(asset)).status,200,asset.href);
      }
    }
    const source=await(await fetch(base+'/plugins/official.virtual-computers/computers.mjs')).text();
    assert.match(source,/a\.href='\/plugins\/official\.virtual-computers\/desktop\.html\?/);
    assert.match(source,/a\.target='_self'/);
    assert.doesNotMatch(source,/a\.target='_blank'/);
    for(const path of ['', '/computers.mjs','/computers.css','/computer-client.mjs','/desktop.html','/desktop.mjs','/desktop.css','/desktop-session.mjs','/theme-prepaint.js','/preferences-v1.mjs']) {
      assert.equal((await fetch(base+'/plugins/official.virtual-computers'+path)).status,200,path);
    }
    assert.equal((await fetch(base+'/plugins/official.virtual-computers',{method:'POST'})).status,405);
    for(const path of ['/package.json','/plugins/official.virtual-computers/../server.mjs','/plugins/official.virtual-computers/%00/secrets']) {
      assert.equal((await fetch(base+path)).status,404);
    }
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('computer manifest grants member use, never administrative or host-device access',async()=>{
  const value=JSON.parse(await readFile(new URL('../manifest.release-template.json',import.meta.url)));
  value.images[0].variants[0].reference='localhost:15016/teamaibox/virtual-computers-plugin';
  value.images[0].variants[0].digest='sha256:'+'a'.repeat(64);
  value.signature.keyId='teamaibox.official/computer-schema-test';value.signature.value=Buffer.alloc(64,7).toString('base64');
  value.signature.payloadDigest=manifestPayloadDigest(value);
  assert.equal(validatePluginManifest(value).pluginId,'official.virtual-computers');
  assert.deepEqual(value.permissions.platformApiScopes,['computer:use']);assert.deepEqual(value.permissions.devices,[]);
});

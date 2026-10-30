import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {manifestPayloadDigest,validatePluginManifest} from '../../../services/plugin-runtime/src/manifest-validator.mjs';

test('phone release template satisfies the real manifest schema after release fields are filled',async()=>{
  // Synthetic signature/image fields validate schema only, never release evidence.
  const value=JSON.parse(await readFile(new URL('../manifest.release-template.json',import.meta.url)));
  value.images[0].variants[0].reference='localhost:15016/teamaibox/virtual-phones-plugin';
  value.images[0].variants[0].digest='sha256:'+'a'.repeat(64);
  value.signature.keyId='teamaibox.official/phone-schema-test';
  value.signature.value=Buffer.alloc(64,7).toString('base64');
  value.signature.payloadDigest=manifestPayloadDigest(value);
  assert.equal(validatePluginManifest(value).pluginId,'official.virtual-phones');
  assert.deepEqual(value.permissions.devices,[]);
  assert.deepEqual(value.permissions.platformApiScopes,['phone:use']);
});

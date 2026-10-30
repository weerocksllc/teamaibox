import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,generateKeyPairSync} from 'node:crypto';
import {buildBundle} from '../tools/package_virtual_phones_ui.mjs';
test('Windows UI package binds its own registry and actual scan bytes',async()=>{
 const template=JSON.parse(await readFile(new URL('../apps/virtual-computers-plugin/manifest.release-template.json',import.meta.url)));
 const bytes=v=>Buffer.from(JSON.stringify(v)),hash=v=>'sha256:'+createHash('sha256').update(v).digest('hex');
 // Synthetic unit inputs only: never used by publication.
 const sbomBytes=bytes({SPDXID:'SPDXRef-DOCUMENT',packages:[{name:'test'}]});
 const scanBytes=bytes({descriptor:{name:'grype',version:'test',db:{status:{valid:true,built:'2026-09-23T00:00:00Z'}}},matches:[]});
 const input={template,imageBytes:bytes({schemaVersion:2,mediaType:'application/vnd.oci.image.manifest.v1+json',config:{digest:'sha256:'+'1'.repeat(64)},layers:[]}),
  repository:'localhost:15016/teamaibox/virtual-computers-plugin',sbomBytes,scanBytes,privateKey:generateKeyPairSync('ed25519').privateKey,keyId:'teamaibox.official/unit-test',clock:new Date('2026-09-23T01:00:00Z'),
  build:{status:'passed',architecture:'linux/arm64/v8',imageConfigDigest:'sha256:'+'1'.repeat(64),scannedAt:'2026-09-23T00:01:00Z',sources:[],
   artifacts:[{path:'test/ui.spdx.json',sha256:hash(sbomBytes)},{path:'test/ui.grype.json',sha256:hash(scanBytes)}]}};
 assert.equal(buildBundle(input).bundle.manifest.id,'official.virtual-computers');
 assert.throws(()=>buildBundle({...input,repository:'localhost:15016/teamaibox/virtual-phones-plugin'}),/registry/);
 assert.throws(()=>buildBundle({...input,scanBytes:bytes({})}));
});

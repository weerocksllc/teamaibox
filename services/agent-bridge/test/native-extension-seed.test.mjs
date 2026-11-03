import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {seedNativeExtensionRuntime} from '../src/native-extension-seed.mjs';

test('native SDK seed preserves user config and is idempotent without changing package state',async t=>{
  const root=await mkdtemp(join(tmpdir(),'tab-sdk-seed-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const source=join(root,'bundled'),target=join(root,'user');
  await mkdir(join(source,'node_modules/@opencode-ai/plugin'),{recursive:true});
  await writeFile(join(source,'node_modules/@opencode-ai/plugin/package.json'),'{"version":"1.19.5"}');
  for(const name of ['package.json','package-lock.json'])await writeFile(join(source,name),'{}');
  await mkdir(target);await writeFile(join(target,'opencode.json'),'{"username":"Synthetic user"}');
  assert.equal(await seedNativeExtensionRuntime(source,target),true);
  assert.equal(await readFile(join(target,'opencode.json'),'utf8'),'{"username":"Synthetic user"}');
  assert.equal(await readFile(join(target,'node_modules/@opencode-ai/plugin/package.json'),'utf8'),'{"version":"1.19.5"}');
  await writeFile(join(target,'package.json'),'{"userOwned":true}');
  assert.equal(await seedNativeExtensionRuntime(source,target),false);
  assert.equal(await readFile(join(target,'package.json'),'utf8'),'{"userOwned":true}');
  assert.ok(!(await readdir(target)).includes('.teamaibox-native-sdk-staging'));
});

test('existing user lockfile alone is not overwritten',async t=>{
  const target=await mkdtemp(join(tmpdir(),'tab-sdk-user-lock-'));t.after(()=>rm(target,{recursive:true,force:true}));
  await writeFile(join(target,'package-lock.json'),'synthetic-existing-lock');
  assert.equal(await seedNativeExtensionRuntime('/nonexistent-bundle',target),false);
  assert.equal(await readFile(join(target,'package-lock.json'),'utf8'),'synthetic-existing-lock');
});

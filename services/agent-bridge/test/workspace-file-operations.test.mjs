import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,mkdir,symlink,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {workspaceFileOperation} from '../src/workspace-file-operations.mjs';

test('Linux descriptor-relative folder/import operations preserve existing bytes and reject escapes',{skip:process.platform!=='linux'},async t=>{
  const temp=await mkdtemp(join(tmpdir(),'tab-workspace-operation-'));t.after(()=>rm(temp,{recursive:true,force:true}));
  const root=join(temp,'owner-a'),other=join(temp,'owner-b');await mkdir(root);await mkdir(other);
  const op=(operation,body)=>workspaceFileOperation({operation,body,root});
  assert.deepEqual(await op('folders',{directory:'/workspace',name:'project'}),{directory:'/workspace/project',status:'created'});
  const body={directory:'/workspace/project',name:'notes.txt',content:Buffer.from('retained\n').toString('base64')};
  assert.equal((await op('files',body)).status,'created');assert.equal((await op('files',{...body,content:Buffer.from('do not overwrite').toString('base64')})).status,'exists');assert.equal(await readFile(join(root,'project/notes.txt'),'utf8'),'retained\n');
  await assert.rejects(op('folders',{directory:'/workspace',name:'project'}),{status:409});
  await symlink(other,join(root,'escape'));
  for(const directory of ['/workspace/../owner-b','/etc','/workspace/escape','/workspace//project'])await assert.rejects(op('files',{...body,directory}));
  await symlink(join(other,'target'),join(root,'project/link'));assert.equal((await op('files',{...body,name:'link'})).status,'exists');assert.deepEqual(await readdir(other),[]);
  for(const name of ['../secret','/etc','a/b','.teamaibox','bad\u0000name'])await assert.rejects(op('files',{...body,name}));
  await assert.rejects(op('files',{...body,container:'other'}));await assert.rejects(op('files',{...body,content:'!!!!'}));
  assert.equal((await op('files',{...body,name:'empty.txt',content:''})).status,'created');
  assert.equal((await op('files',{...body,name:'.gitignore'})).status,'created');
});

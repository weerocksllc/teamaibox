import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeFilePatch} from '../src/assistant/native-file-patch.ts';
test('native file patch preserves Unicode, empty files and final newlines',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'tab-native-patch-'));
  try{
    execFileSync('git',['init','-q'],{cwd:directory});
    for(const [before,after] of [['old\n','new\n'],['','one'],['last line',''],['日语\n终端','العربية\n'],['a\r\nb\r\n','c\r\n']]){
      await writeFile(join(directory,'sample.txt'),before);
      execFileSync('git',['apply','--whitespace=nowarn','-'],{cwd:directory,input:nativeFilePatch('sample.txt',before,after)});
      assert.equal(await readFile(join(directory,'sample.txt'),'utf8'),after);
    }
    await writeFile(join(directory,'sample.txt'),'concurrent change\n');
    assert.throws(()=>execFileSync('git',['apply','-'],{cwd:directory,input:nativeFilePatch('sample.txt','original\n','new\n'),stdio:['pipe','pipe','pipe']}));
    assert.equal(await readFile(join(directory,'sample.txt'),'utf8'),'concurrent change\n');
  }finally{await rm(directory,{recursive:true,force:true});}
});
test('patch paths cannot escape workspace or inject patch headers',()=>{
  for(const path of ['../secrets','/etc/config','a\nb','a/../b','a\\b','a\tb','a//b'])assert.throws(()=>nativeFilePatch(path,'a','b'));
  assert.equal(nativeFilePatch('same','a','a'),'');
});
test('native new-file patch creates exact content and refuses to replace an existing file',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'tab-native-create-'));
  try{
    execFileSync('git',['init','-q'],{cwd:directory});
    const source='{\n  "command": {}\n}\n';const patch=nativeFilePatch('opencode.json',null,source);
    execFileSync('git',['apply','-'],{cwd:directory,input:patch});
    assert.equal(await readFile(join(directory,'opencode.json'),'utf8'),source);
    assert.throws(()=>execFileSync('git',['apply','-'],{cwd:directory,input:patch,stdio:['pipe','pipe','pipe']}));
    assert.equal(await readFile(join(directory,'opencode.json'),'utf8'),source);
    assert.throws(()=>nativeFilePatch('opencode.json',null,''));
  }finally{await rm(directory,{recursive:true,force:true});}
});

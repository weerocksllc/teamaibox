import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDarwinAvailableMemory} from './installer_probe_memory.mjs';
test('installer probe uses the system available-memory observation',()=>{
  assert.equal(parseDarwinAvailableMemory('The system has 25769803776 (1572864 pages with a page size of 16384).\nSystem-wide memory free percentage: 44%\n'),11338713661);
});
test('zero available memory stays zero and missing observations never become unlimited',()=>{
  assert.equal(parseDarwinAvailableMemory('The system has 4096 bytes.\nSystem-wide memory free percentage: 0%'),0);
  for(const output of ['','The system has 4096 bytes.','The system has 4096 bytes.\nSystem-wide memory free percentage: 101%'])
    assert.throws(()=>parseDarwinAvailableMemory(output),/observation_invalid/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const contract=JSON.parse(readFileSync(new URL('../../../services/agent-bridge/opencode-native-contract.json',import.meta.url)));
const map=readFileSync(new URL('../../../docs/development/native-assistant-capabilities.md',import.meta.url),'utf8');
test('capability map covers each pinned native operation exactly once with its actual method and path',()=>{
  const rows=map.split('\n').map(line=>line.match(/^\| `([^`]+)` \| `([A-Z]+) ([^`]+)` \| (.+) \| (.+) \| (.+) \|$/)).filter(Boolean);
  assert.equal(rows.length,contract.operations.length);const ids=new Set();
  for(const row of rows){assert.ok(!ids.has(row[1]),row[1]);ids.add(row[1]);const operation=contract.operations.find(item=>item.operation===row[1]);assert.ok(operation,row[1]);assert.equal(row[2],operation.method);assert.equal(row[3],operation.path);assert.ok(row[5].trim());assert.ok(row[6].trim());}
  assert.ok(!map.includes('v1 component draft'),'stale draft statuses must be reconciled, not counted as acceptance');
});

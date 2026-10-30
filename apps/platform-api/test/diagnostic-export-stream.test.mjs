import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { MemoryObservabilityRepository } from '../src/operations/memory-observability-repository.mjs';
import { OperationalDiagnosticsService } from '../src/operations/operational-diagnostics-service.mjs';
import { OperationsHttpApi } from '../src/operations/operations-http-api.mjs';

const context = { identityId: randomUUID(), permissions: ['operations:view','diagnostic_sensitive:view'] };
function setup(options={}) {
  const repository = new MemoryObservabilityRepository(), audits=[];
  const service = new OperationalDiagnosticsService({ repository, audit: async e=>audits.push(e), ...options });
  return { repository, service, audits };
}
async function contents(body) { let result=''; for await(const value of body) result+=value; return result; }

test('export traverses over 5000 rows per collection with tied timestamps and over 100 content records', async()=>{
  const {repository,service,audits}=setup({sensitiveContentSource:{async *collect(){for(let i=0;i<137;i++)yield{referenceId:`item-${i}`,content:'测试'};}}});
  const at=new Date('2026-08-01T00:00:00Z');
  for(let i=0;i<5017;i++){
    const id=randomUUID();
    await repository.insertSignal({signalId:id,observedAt:at,correlationId:'complete-export-test',producer:{kind:'worker',key:'test'},facts:{}});
    await repository.insertHealth({healthId:id,observedAt:at,correlationId:'complete-export-test',target:{kind:'worker',key:'test'},state:'healthy',facts:{}});
    await repository.upsertAlert({alertId:id,alertKey:`alert-${i}`,openedAt:at,lastSeenAt:at,resolvedAt:null,target:{kind:'worker',key:'test'},correlationId:'complete-export-test'});
  }
  const result=await service.streamDiagnostics({context,request:{since:'2026-01-01',until:'2026-09-01',includeSensitive:true,reason:'long reason '.repeat(30)}});
  assert.equal(audits.length,0);
  const {bundleDigest,...bundle}=JSON.parse(await contents(result.body));
  for(const key of ['signals','health','alerts'])assert.equal(bundle[key].length,5017);
  assert.equal(new Set(bundle.signals.map(v=>v.signalId)).size,5017);
  assert.equal(bundle.sensitiveContent.length,137);
  assert.equal(bundleDigest,`sha256:${createHash('sha256').update(JSON.stringify(bundle)).digest('hex')}`);
  assert.equal(audits.length,1);
});

test('export is lazy, responds to cancellation, and does not record an abandoned transfer as complete',async()=>{
  const {repository,service,audits}=setup();let queries=0;
  const original=repository.listSignals.bind(repository);
  repository.listSignals=async(...args)=>{queries++;return original(...args);};
  const control=new AbortController();
  const result=await service.streamDiagnostics({context,signal:control.signal});
  assert.equal(queries,0);
  const iterator=result.body[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  control.abort();
  await assert.rejects(iterator.next(),{name:'AbortError'});
  assert.equal(queries,0);assert.equal(audits.length,0);
});

test('repository errors do not produce valid truncated JSON or a completion record',async()=>{
  const {repository,service,audits}=setup();
  repository.listHealth=async()=>{throw Error('database unavailable');};
  const result=await service.streamDiagnostics({context});let partial='';
  await assert.rejects(async()=>{for await(const text of result.body)partial+=text;},/database unavailable/);
  assert.throws(()=>JSON.parse(partial));assert.equal(audits.length,0);
});

test('stream HTTP export validates permission before sending bytes and carries filename and abort signal',async()=>{
  const {service}=setup();const api=new OperationsHttpApi({diagnostics:service});
  await assert.rejects(api.handle({method:'POST',pathname:'/api/v1/admin/operations/diagnostic-exports',context:{...context,permissions:[]}}),{code:'operations_permission_required'});
  const result=await api.handle({method:'POST',pathname:'/api/v1/admin/operations/diagnostic-exports',context});
  assert.equal(result.kind,'stream');assert.equal(result.status,201);
  const bundle=JSON.parse(await contents(result.body));
  assert.ok(result.headers['content-disposition'].includes(bundle.exportId));
});

test('invalid date ordering remains rejected without imposing a month cutoff',async()=>{
  const {service}=setup();
  await assert.rejects(service.streamDiagnostics({context,request:{since:'2026-09-01',until:'2026-01-01'}}),{code:'diagnostic_range_invalid'});
});

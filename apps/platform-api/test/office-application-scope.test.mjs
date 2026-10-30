import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { createPlatformApiServer } from '../server/platform-api.mjs';
import { LocalAuthentication } from '../src/identity/auth-service.mjs';
import { MemoryIdentityRepository } from '../src/identity/memory-repository.mjs';
import { PasswordHasher } from '../src/identity/password.mjs';
import { IdentityPreferencesService } from '../src/identity/preferences-service.mjs';
import { PostgresModelLifecycleRepository } from '../src/models/postgres-model-lifecycle-repository.mjs';
import { PostgresModelReportCatalog } from '../src/models/postgres-model-report-catalog.mjs';

const root = new URL('../../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('retired application has no executable source, permission, catalog entry or supported capability', () => {
  for (const path of ['apps/model-studio-plugin/src', 'apps/platform-api/src/model-studio',
    'services/fine-tuning-worker/src', 'apps/platform-api/server/fine-tuning-runtime.mjs']) {
    assert.equal(existsSync(new URL(path, root)), false, path);
  }
  for (const path of ['deploy/applications/built-in-applications.v1.json',
    'packages/contracts/compute/capability.v1.schema.json',
    'apps/platform-api/server/appliance-main.mjs', 'apps/platform-api/server/platform-api.mjs']) {
    assert.doesNotMatch(read(path), /official\.model-studio|model_studio:use|fine_tuning|FineTuningRuntime/);
  }
  assert.match(read('deploy/applications/built-in-applications.v1.json'), /official\.assistant/);
  assert.equal(existsSync(new URL('apps/platform-api/src/models/model-lifecycle-service.mjs', root)), true);
});

test('removed application URLs return not found instead of accepting or queueing work', async t => {
  const repository = new MemoryIdentityRepository();
  const authentication = await LocalAuthentication.create({repository,
    hasher: new PasswordHasher({memory:8192,passes:2,parallelism:2,tagLength:32})});
  const server = createPlatformApiServer({authentication,
    preferences:new IdentityPreferencesService({repository}), publicOrigin:'https://spark.test',
    logger:{warn(){},info(){},error(){}}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  for (const path of ['base-profiles','datasets','experiments','candidates','promotion-requests']) {
    for (const method of ['GET','POST']) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/model-studio/${path}`,
        {method,headers:{'x-forwarded-proto':'https',origin:'https://spark.test'}});
      assert.equal(response.status,404,`${method} ${path}`);
      await response.text();
    }
  }
});

test('model management excludes retired capabilities without changing ordinary inference history', async () => {
  const queries=[];
  const database={async query(sql){queries.push(sql);return {rows:[]};},
    async transaction(callback){return callback(this);}};
  const repository=new PostgresModelLifecycleRepository({database});
  assert.equal(await repository.findProfile('retired'),null);
  assert.deepEqual(await repository.listProfiles({limit:100}),[]);
  assert.equal(await repository.transitionLifecycle({profileId:'retired'}),null);
  assert.equal(await new PostgresModelReportCatalog({database}).getProfile('retired'),null);
  assert.equal(queries.length,4);
  for(const sql of queries) {
    assert.match(sql,/JOIN compute\.capabilities capability/);
    assert.match(sql,/capability\.lifecycle_state <> 'retired'/);
    assert.doesNotMatch(sql,/certification_state\s*<>|DELETE|DROP/);
  }
});

test('upgrade retires application and grants without erasing existing records', () => {
  const sql=read('packages/persistence/migrations/000106_office_application_scope.up.sql');
  assert.match(sql,/DELETE FROM iam\.permissions/);
  assert.match(sql,/lifecycle_state = 'uninstalled'/);
  assert.match(sql,/CHECK \(modality <> 'fine_tuning'\) NOT VALID/);
  assert.doesNotMatch(sql,/DROP TABLE|DELETE FROM compute\./);
});

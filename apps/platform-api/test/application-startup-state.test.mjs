import test from 'node:test';
import assert from 'node:assert/strict';
import { applicationStartupState } from '../src/applications/application-catalog-service.mjs';

test('startup state explains only this app model blockers, not authorization or broken routes', () => {
  const loading = [{ available: false, startupState: 'loading' }];
  assert.equal(applicationStartupState(loading, ['model_route_unavailable']), 'loading');
  assert.equal(applicationStartupState(loading, ['authorization_denied']), 'unavailable');
  assert.equal(applicationStartupState(loading, ['plugin_unhealthy', 'model_route_unavailable']), 'unavailable');
  assert.equal(applicationStartupState([{ available: true, startupState: 'ready' }], []), 'ready');
  assert.equal(applicationStartupState([...loading, { available: false, startupState: 'retrying' }], ['model_route_unavailable']), 'retrying');
});

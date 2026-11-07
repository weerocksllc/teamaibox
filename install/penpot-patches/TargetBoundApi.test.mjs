import assert from 'node:assert/strict';
import test from 'node:test';
import { TargetBoundApi } from './TargetBoundApi.ts';

function fixture() {
  let current = { connectionId: 'connection-fixture', generation: 1, profileId: 'profile-fixture',
    fileId: 'file-fixture', pageId: 'page-fixture' };
  const expected = { ...current };
  const raw = {
    $file: current.fileId, $page: current.pageId, name: 'Synthetic shape',
    rename(name) { this.name = name; },
  };
  const boundary = new TargetBoundApi(expected, { current: () => current });
  const api = boundary.wrap({ shape: raw, inspect: callback => callback(raw),
    identity: shape => shape === raw, async shapeLater() { await Promise.resolve(); return raw; } });
  return { api, raw, boundary, expected, switchTarget(value) { current = value; } };
}

test('native handles and callback arguments stay wrapped; valid changes reach native objects', async () => {
  const { api, raw } = fixture();
  api.shape.rename('Changed');
  assert.equal(raw.name, 'Changed');
  assert.equal(api.identity(api.shape), true);
  assert.equal((await api.shapeLater()).name, 'Changed');
  assert.equal(api.inspect(shape => Object.getPrototypeOf(shape)), null);
  assert.equal(api.inspect(shape => shape.$file), undefined);
  assert.equal(api.shape.constructor, undefined);
  assert.equal(api.shape.__proto__, undefined);
  assert.equal(Object.getOwnPropertyDescriptor(api.shape, '$file'), undefined);
  assert.equal(Object.getOwnPropertyDescriptor(api.shape, 'name').get(), 'Changed');
  assert.throws(() => Object.defineProperty(api.shape, 'escape', { value: raw }));
  assert.throws(() => Object.setPrototypeOf(api.shape, raw));
  assert.throws(() => Object.preventExtensions(api.shape));
});

test('retained methods, descriptor getters and async continuations reject changed target', async () => {
  for (const key of ['connectionId', 'generation', 'profileId', 'fileId', 'pageId']) {
    const { api, raw, expected, switchTarget } = fixture();
    const shape = api.shape, rename = shape.rename;
    const getter = Object.getOwnPropertyDescriptor(shape, 'name').get;
    const pending = api.shapeLater();
    switchTarget({ ...expected, [key]: key === 'generation' ? 2 : 'another-target' });
    await assert.rejects(pending, /no longer active/);
    assert.throws(() => rename('Wrong target'));
    assert.throws(() => getter());
    switchTarget(expected);
    assert.throws(() => { shape.name = 'Reactivated'; });
    assert.equal(raw.name, 'Synthetic shape');
  }
});

test('finishing or losing authority revokes all escaped handles', () => {
  const { api, raw, boundary } = fixture();
  const shape = api.shape;
  boundary.close();
  assert.throws(() => shape.rename('After completion'));
  assert.throws(() => Reflect.ownKeys(shape));
  assert.equal(raw.name, 'Synthetic shape');
  const other = fixture();
  other.switchTarget(undefined);
  assert.throws(() => other.api.shape);
});

test('cross-file handles and thrown native objects never cross the boundary', () => {
  const { boundary, expected } = fixture();
  assert.throws(() => boundary.wrap({ $file: 'another-file' }), /another target/);
  const hostOnly = { privateFixtureMarker: 'not-for-generated-code' };
  const api = boundary.wrap({
    get danger() { throw hostOnly; },
    fail() { throw hostOnly; },
  });
  for (const invoke of [() => api.danger, () => api.fail()]) {
    assert.throws(invoke, error => error instanceof Error && !('privateFixtureMarker' in error));
  }
  assert.throws(() => new TargetBoundApi(expected, { current() { throw hostOnly; } }),
    error => error instanceof Error && !('privateFixtureMarker' in error));
});

test('native SVG completion receives an unforgeable per-call fence', async () => {
  for (const changed of ['generation', 'connectionId', 'close']) {
    const { boundary, expected, switchTarget } = fixture();
    let release, inserted = false;
    const ready = new Promise(resolve => { release = resolve; });
    const native = {
      async createShapeFromSvgWithImages(_svg, active) {
        await ready;
        if (active() !== true) throw new Error('Not authorized');
        inserted = true;
        return { name: 'Synthetic SVG' };
      },
    };
    const guarded = boundary.wrapEditorApi(native);
    const pending = guarded.createShapeFromSvgWithImages('<svg/>', () => true);
    if (changed === 'close') boundary.close();
    else switchTarget({ ...expected, [changed]: changed === 'generation' ? 2 : 'new-connection' });
    release();
    await assert.rejects(pending);
    assert.equal(inserted, false);
  }
});

test('unchanged editor target permits native SVG insertion without changing ordinary helpers', async () => {
  const { boundary } = fixture();
  const native = {
    createShapeFromSvg(_svg, active) { assert.equal(active(), true); return { name: 'SVG' }; },
    async createShapeFromSvgWithImages(_svg, active) {
      await Promise.resolve();
      assert.equal(active(), true);
      return { name: 'SVG with images' };
    },
    helper: { createShapeFromSvg(...args) { return args.length; } },
  };
  const guarded = boundary.wrapEditorApi(native);
  assert.equal(guarded.createShapeFromSvg('<svg/>').name, 'SVG');
  assert.equal((await guarded.createShapeFromSvgWithImages('<svg/>')).name, 'SVG with images');
  assert.equal(guarded.helper.createShapeFromSvg('one'), 1);
});

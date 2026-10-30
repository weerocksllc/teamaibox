import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, realpath, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { repair } from '../tools/repair_protected_office_maintenance_validity.mjs';
import { ProtectedOfficeMaintenanceSigner } from '../services/maintenance-controller/src/protected-office-maintenance-signer.mjs';
import { ProductionProtectedMaintenanceSignatureVerifier } from '../services/scheduler/src/production-protected-maintenance-signature-verifier.mjs';

test('repairs empty expiry without changing key identity and real signatures then verify', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'office-public-validity-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const keyringFile = join(root, 'public.json'), notBeforeFile = join(root, 'before'), notAfterFile = join(root, 'after');
  const privateKeyFile = join(root, 'private.key');
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = { keyId: 'protected-office-main-v1', algorithm: 'Ed25519', status: 'active',
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
    publicKeyDigest: `sha256:${createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')}`,
    notBefore: '2026-09-05T19:04:19.000Z', notAfter: '' };
  const original = JSON.stringify({ schemaVersion: 1, keys: [key] });
  await writeFile(keyringFile, original);
  await writeFile(notBeforeFile, `${key.notBefore}\n`);
  await writeFile(notAfterFile, '');
  const privateBytes = privateKey.export({ type: 'pkcs8', format: 'pem' });
  await writeFile(privateKeyFile, privateBytes, { mode: 0o600 });
  const args = { keyringFile, notBeforeFile, notAfterFile, runId: 'protected-office-maintenance-validity-20260906-a1' };
  const result = await repair(args);
  assert.equal(result.privateKeyRead, false);
  assert.equal(result.notAfter, '2036-09-02T19:04:19.000Z');
  assert.equal(await readFile(`${keyringFile}.${args.runId}.before`, 'utf8'), original);
  assert.equal(await readFile(privateKeyFile, 'utf8'), privateBytes);
  const workerIds = ['00000000-0000-4000-8000-000000000201'];
  const signer = new ProtectedOfficeMaintenanceSigner({ privateKeyFile, allowTestRoot: true });
  const context = await signer.sign({ transactionId: '00000000-0000-4000-8000-000000000202',
    workerIds, allowedOperations: ['protected-set.maintenance'], maintenanceGeneration: 1,
    issuedAt: '2026-09-06T00:00:00.000Z', expiresAt: '2026-09-06T00:05:00.000Z' });
  const verifier = new ProductionProtectedMaintenanceSignatureVerifier({ trustedKeyringFile: keyringFile, allowTestRoot: true });
  assert.equal((await verifier.verify({ context, operation: 'protected-set.maintenance',
    workers: workerIds.map(workerId => ({ workerId, placementClass: 'protected-resident', maintenanceGeneration: 1 })),
    now: new Date(context.issuedAt) })).authorized, true);
  await assert.rejects(repair(args), /not the exact empty-expiry/);
  // Already valid or expired keys cannot be silently extended by this repair.
  const repaired = JSON.parse(await readFile(keyringFile, 'utf8'));
  repaired.keys[0].notAfter = '2026-09-05T20:00:00.000Z';
  await chmod(keyringFile, 0o600);
  await writeFile(keyringFile, JSON.stringify(repaired));
  await assert.rejects(repair({ ...args, runId: 'protected-office-maintenance-validity-20260906-a2' }), /not the exact empty-expiry/);
});

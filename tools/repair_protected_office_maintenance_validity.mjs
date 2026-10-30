import { createHash, createPublicKey } from 'node:crypto';
import { copyFile, lstat, readFile, realpath, writeFile, rename, chown } from 'node:fs/promises';
import { constants } from 'node:fs';
import { pathToFileURL } from 'node:url';

const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
async function boundedFile(path, maximum) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path || info.size > maximum) {
    throw new Error('maintenance public metadata must be a bounded regular file');
  }
  return readFile(path);
}

/** Repair only the known empty-expiry initialization defect; never rotate keys. */
export async function repair({ keyringFile, notBeforeFile, notAfterFile, runId, ownership = null }) {
  if (!/^protected-office-maintenance-validity-[0-9]{8}-a[1-9][0-9]*$/.test(runId)) throw new Error('invalid repair identity');
  const oldBytes = await boundedFile(keyringFile, 256 * 1024);
  const document = JSON.parse(oldBytes);
  const before = (await boundedFile(notBeforeFile, 64)).toString().trim();
  const after = await boundedFile(notAfterFile, 64);
  const key = document.keys?.[0];
  if (document.schemaVersion !== 1 || document.keys?.length !== 1
      || key.keyId !== 'protected-office-main-v1' || key.algorithm !== 'Ed25519'
      || key.status !== 'active' || key.notBefore !== before || key.notAfter !== '' || after.length !== 0
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/.test(before)
      || new Date(before).toISOString() !== before) throw new Error('not the exact empty-expiry defect');
  const publicKey = createPublicKey(key.publicKeyPem);
  if (publicKey.asymmetricKeyType !== 'ed25519'
      || hash(publicKey.export({ type: 'spki', format: 'der' })) !== key.publicKeyDigest) {
    throw new Error('public key identity drifted');
  }
  const expiry = new Date(new Date(before).getTime() + 3650 * 86400000).toISOString();
  key.notAfter = expiry;
  const repaired = Buffer.from(`${JSON.stringify(document)}\n`);
  // Exclusive backups and temporary files: prior failed material is never lost.
  await copyFile(keyringFile, `${keyringFile}.${runId}.before`, constants.COPYFILE_EXCL);
  await copyFile(notAfterFile, `${notAfterFile}.${runId}.before`, constants.COPYFILE_EXCL);
  const target = `${keyringFile}.${runId}.new`;
  const validity = `${notAfterFile}.${runId}.new`;
  await writeFile(target, repaired, { flag: 'wx', mode: 0o444 });
  await writeFile(validity, `${expiry}\n`, { flag: 'wx', mode: 0o444 });
  if (ownership) {
    await chown(target, ownership.keyring, ownership.keyring);
    await chown(validity, ownership.maintenance, ownership.maintenance);
  }
  await rename(validity, notAfterFile);
  await rename(target, keyringFile);
  return { runId, status: 'repaired', oldDigest: hash(oldBytes), newDigest: hash(repaired),
    publicKeyDigest: key.publicKeyDigest, notBefore: before, notAfter: expiry,
    privateKeyRead: false, privateKeyChanged: false, previousMetadataPreserved: true };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = await repair({
    keyringFile: '/run/teamaibox/maintenance-keys/protected-office.ed25519.json',
    notBeforeFile: '/var/lib/teamaibox-maintenance/protected-office.ed25519.not-before',
    notAfterFile: '/var/lib/teamaibox-maintenance/protected-office.ed25519.not-after',
    runId: process.argv[2], ownership: { keyring: 1000, maintenance: 10001 },
  });
  console.log(JSON.stringify(result));
}

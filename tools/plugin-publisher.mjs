// A reusable publisher identity. Run on the appliance's encrypted storage;
// only the public key and signatures leave this process.
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

export async function publisherKey(filename, { initialize = false } = {}) {
  if (!isAbsolute(filename)) throw new Error('publisher key path must be absolute');
  const directory = dirname(filename);
  if (initialize) await mkdir(directory, { mode: 0o700, recursive: true });
  const parent = await lstat(directory);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077)
      || parent.uid !== process.getuid()) throw new Error('publisher directory must be private and owned');
  if (initialize) {
    const { privateKey } = generateKeyPairSync('ed25519');
    const bytes = privateKey.export({ type: 'pkcs8', format: 'pem' });
    let file;
    try {
      file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await file.writeFile(bytes); await file.sync();
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { await file?.close(); }
  }
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > 8192)
      throw new Error('publisher key must be a private owned regular file');
    const bytes = await file.readFile();
    try {
      const key = createPrivateKey(bytes);
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('publisher key must be Ed25519');
      return key;
    } finally { bytes.fill(0); }
  } finally { await file.close(); }
}

async function main() {
  const [action, filename] = process.argv.slice(2);
  if (!['initialize', 'public', 'sign'].includes(action) || process.argv.length !== 4)
    throw new Error('usage: plugin-publisher.mjs initialize|public|sign /encrypted/path/key.pem');
  const key = await publisherKey(filename, { initialize: action === 'initialize' });
  if (action !== 'sign') {
    process.stdout.write(createPublicKey(key).export({ type: 'spki', format: 'pem' })); return;
  }
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('signing payload too large');
    chunks.push(chunk);
  }
  if (!size) throw new Error('empty signing payload');
  process.stdout.write(sign(null, Buffer.concat(chunks), key).toString('base64'));
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch(() => { process.stderr.write('publisher operation failed\n'); process.exitCode = 1; });
}

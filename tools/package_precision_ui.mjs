import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

// Derived deployment images contain only static deltas, not a rebuilt backend.
const root = resolve(new URL('..', import.meta.url).pathname);
const stage = await mkdtemp(join(tmpdir(), 'teamaibox-precision-ui-'));
const files = execFileSync('git', ['diff', '--name-only', 'delivery-2026-10-22', '--', 'apps'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
const manifest = [];
const save = async (relative, bytes) => {
  const destination = join(stage, 'payload', relative);
  await mkdir(resolve(destination, '..'), { recursive: true });
  await writeFile(destination, bytes);
  manifest.push({ path: relative, sha256: createHash('sha256').update(bytes).digest('hex') });
};
for (const path of files) {
  const match = /^apps\/([a-z-]+)-plugin\/src\/public\/(.+)$/.exec(path);
  if (!match) continue;
  await save(`${match[1]}/${match[2]}`, await readFile(join(root, path)));
}
const css = Buffer.concat(await Promise.all(['tokens.css', 'primitives.css', 'preferences.css', 'applications.css'].map(name => readFile(join(root, 'packages/ui-system/src', name)))));
for (const app of ['messaging', 'team-drive', 'drawing', 'ocr', 'asr', 'translation', 'virtual-phones', 'virtual-computers', 'wireless-casting']) await save(`${app}/ui-system.css`, css);
async function web(path = '') {
  for (const entry of await readdir(join(root, 'apps/web/dist', path), { withFileTypes: true })) {
    const relative = join(path, entry.name);
    if (entry.isDirectory()) await web(relative);
    else if (entry.isFile() && !entry.name.endsWith('.map')) await save(`web/${relative}`, await readFile(join(root, 'apps/web/dist', relative)));
  }
}
await web();
await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
execFileSync('tar', ['--no-xattrs', '-czf', join(stage, 'payload.tar.gz'), '-C', stage, 'payload', 'manifest.json'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
console.log(JSON.stringify({ stage, artifact: join(stage, 'payload.tar.gz'), files: manifest.length }));

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "dist");
const indexPath = resolve(root, "index.html");
const index = await readFile(indexPath, "utf8");
if (!index.includes('<div id="root"></div>')) throw new Error("Web bundle is missing the React mount point");
if (/<script[^>]+src=["']https?:/i.test(index)) throw new Error("Web bundle loads a remote executable script");
if (!index.includes('src="/theme-prepaint.js"')) throw new Error("Web bundle is missing pre-paint theme selection");
const prepaint = await readFile(resolve(root, "theme-prepaint.js"), "utf8");
if (!prepaint.includes("document.documentElement.dataset.theme")) throw new Error("Pre-paint theme asset is invalid");

const references = [...index.matchAll(/(?:src|href)=["']\/(assets\/[A-Za-z0-9._-]+)["']/g)]
  .map((match) => match[1]);
if (references.length < 2) throw new Error("Web bundle is missing hashed JavaScript or CSS assets");

const checked = [];
for (const reference of references) {
  const path = resolve(root, reference);
  if (!path.startsWith(root + sep)) throw new Error("Web bundle reference leaves the output directory");
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size === 0) throw new Error(`Web bundle asset is empty: ${reference}`);
  checked.push({ reference, bytes: metadata.size });
}

const script = checked.find((asset) => asset.reference.endsWith(".js"));
const stylesheet = checked.find((asset) => asset.reference.endsWith(".css"));
if (!script || !stylesheet) throw new Error("Web bundle must include JavaScript and CSS assets");
if (script.bytes > 500_000) throw new Error(`Web bundle entry JavaScript exceeds the 500000 byte budget: ${script.bytes}`);
const scriptSource = await readFile(resolve(root, script.reference), "utf8");
if (!scriptSource.includes("Team AI Box")) throw new Error("Web bundle does not contain product application code");

const assetRoot = resolve(root, "assets");
const entries = await readdir(assetRoot, { withFileTypes: true });
const productionAssets = [];
const sourceMaps = new Set();
for (const entry of entries) {
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Web bundle asset is not a regular file: assets/${entry.name}`);
  const reference = `assets/${entry.name}`;
  if (entry.name.endsWith(".map")) {
    if (!entry.name.endsWith(".js.map")) throw new Error(`Web bundle contains an unsupported source map: ${reference}`);
    sourceMaps.add(reference);
    continue;
  }
  if (!/^[A-Za-z0-9._-]+\.(?:js|css)$/.test(entry.name)) throw new Error(`Web bundle contains an unsupported production asset: ${reference}`);
  const metadata = await stat(resolve(root, reference));
  if (metadata.size === 0) throw new Error(`Web bundle asset is empty: ${reference}`);
  productionAssets.push({ reference, bytes: metadata.size });
}

const available = new Set(productionAssets.map((asset) => asset.reference));
const reachable = new Set(references);
const queue = references.filter((reference) => reference.endsWith(".js"));
while (queue.length > 0) {
  const reference = queue.shift();
  const source = await readFile(resolve(root, reference), "utf8");
  const dependencies = [
    ...source.matchAll(/(?:import\(|from)\s*["'`]\.\/([^"'`]+\.js)["'`]/g),
    // Vite records lazily loaded styles alongside their JavaScript chunks.
    ...source.matchAll(/["'`]assets\/([A-Za-z0-9._-]+\.(?:js|css))["'`]/g),
  ].map((match) => `assets/${match[1]}`);
  for (const dependency of dependencies) {
    if (!available.has(dependency)) throw new Error(`Web bundle JavaScript dependency is missing: ${dependency}`);
    if (!reachable.has(dependency)) {
      reachable.add(dependency);
      if (dependency.endsWith(".js")) queue.push(dependency);
    }
  }
}
for (const asset of productionAssets) {
  if (!reachable.has(asset.reference)) throw new Error(`Web bundle contains an unreachable production asset: ${asset.reference}`);
  if (asset.reference.endsWith(".js") && !sourceMaps.has(`${asset.reference}.map`)) throw new Error(`Web bundle JavaScript source map is missing: ${asset.reference}.map`);
}
for (const sourceMap of sourceMaps) {
  if (!available.has(sourceMap.slice(0, -4))) throw new Error(`Web bundle contains an orphaned source map: ${sourceMap}`);
}

const manifestHash = createHash("sha256");
for (const asset of productionAssets.sort((left, right) => left.reference.localeCompare(right.reference))) {
  const bytes = await readFile(resolve(root, asset.reference));
  manifestHash.update(asset.reference).update("\0").update(createHash("sha256").update(bytes).digest("hex")).update("\0").update(String(asset.bytes)).update("\n");
}
console.log(JSON.stringify({
  assets: productionAssets.length,
  entryAssets: checked.length,
  entryScriptBytes: script.bytes,
  sourceMaps: sourceMaps.size,
  bytes: productionAssets.reduce((sum, item) => sum + item.bytes, 0),
  digest: `sha256:${manifestHash.digest("hex")}`,
}));

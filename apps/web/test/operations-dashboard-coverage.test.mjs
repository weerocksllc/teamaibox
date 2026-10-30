import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panel = await readFile(new URL("../src/device/AppliancePanel.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("administrator dashboard renders the complete live resource and attribution surface", () => {
  for (const fact of [
    "domains.accelerator?.powerWatts", "domains.storage?.readBytesPerSecond",
    "domains.storage?.writeBytesPerSecond", "domains.network?.transmitBytesPerSecond",
    "domains.network?.availableBitsPerSecond", "domains.codecs?.encodeCapacity",
    "domains.unifiedMemory?.dedicatedAcceleratorMemoryBytes", "value.jobs",
    "value.reservations", "value.processes", "value.workers", "value.models",
    "value.queues", "value.coreServices",
  ]) assert.ok(panel.includes(fact), `missing dashboard fact ${fact}`);
  assert.match(panel, /worker\.jobId \?/);
  assert.match(panel, /metric\?\.reasonCode/);
  assert.match(panel, /dashboard\.alerts\.length === 0/);
});

test("single appliance attribution retains responsive layouts without a node picker", () => {
  assert.match(panel, /dashboard\.appliance\.metrics/);
  assert.doesNotMatch(panel, /selectedNode|cluster|aggregate/);
  assert.match(styles, /@media \(max-width: 720px\)[\s\S]*?\.device-telemetry-columns[^}]*grid-template-columns: minmax\(0, 1fr\)/);
});

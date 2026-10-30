import assert from "node:assert/strict";
import test from "node:test";

import { StaticOfflineMediaInventory } from "../src/static-offline-media-inventory.mjs";

const nodeId = "018f6f18-24d7-7c21-9b62-8c0174199501";
const declaration = { nodeId, mountId: "018f6f18-24d7-7c21-9b62-8c0174199502", filesystemUuid: "018f6f18-24d7-7c21-9b62-8c0174199503",
  deviceIdentitySha256: `sha256:${"a".repeat(64)}`, filesystemType: "ext4", transport: "usb", volumeLabel: "TEAM AI OFFLINE", capacityBytes: 1024,
  readOnly: true, mountMode: "read-only" };

test("static offline inventory returns only the exact node and never exposes an arbitrary path", async () => {
  const inventory = new StaticOfflineMediaInventory({ media: [declaration] });
  const result = await inventory.listReadOnlyMedia({ nodeId });
  assert.equal(result.length, 1); assert.equal(result[0].mountId, declaration.mountId); assert.equal("nodeId" in result[0], false); assert.equal("path" in result[0], false);
  assert.deepEqual(await inventory.listReadOnlyMedia({ nodeId: "018f6f18-24d7-7c21-9b62-8c0174199511" }), []);
});

test("static offline inventory rejects writable or duplicate media", () => {
  assert.throws(() => new StaticOfflineMediaInventory({ media: [{ ...declaration, readOnly: false }] }));
  assert.throws(() => new StaticOfflineMediaInventory({ media: [declaration, { ...declaration, mountId: "018f6f18-24d7-7c21-9b62-8c0174199512" }] }));
});

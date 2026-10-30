const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
import { PHONE_ROM_ID } from "./phone-rom.mjs";

// One installed declaration is shared by admission and execution. Neither may
// accept options the other rejects. null means resource-based placement;
// a non-null count is an administrator-configured policy, not a product tier.
export function phoneApprovedNodes(value) {
  if (!Array.isArray(value)) throw new TypeError("Phone approved nodes must be an array");
  const nodes = new Map(value.map(node => {
    if (!node || typeof node !== "object" || Array.isArray(node)
        || Object.keys(node).some(key => !["nodeId", "nodeGeneration", "imageDigest", "poolId", "maximumPhones", "roms", "runtimeMaintenance"].includes(key))
        || !UUID.test(node.nodeId ?? "") || !Number.isSafeInteger(node.nodeGeneration) || node.nodeGeneration < 1
        || !/^sha256:[a-f0-9]{64}$/.test(node.imageDigest ?? "") || !/^[a-z][a-z0-9_.-]{2,127}$/.test(node.poolId ?? "")
        || node.maximumPhones !== null && (!Number.isSafeInteger(node.maximumPhones) || node.maximumPhones < 1)) {
      throw new TypeError("Phone approved-node configuration is invalid");
    }
    if (node.roms !== undefined && (!Array.isArray(node.roms) || node.roms.length < 1
        || node.roms.some(rom => !rom || typeof rom !== "object" || Array.isArray(rom)
          || Object.keys(rom).some(key=>!['romVersionId','imageDigest','cameraSources','runtimeImageDigest','androidSystemDigest'].includes(key))
          || !PHONE_ROM_ID.test(rom.romVersionId ?? "") || !/^sha256:[a-f0-9]{64}$/.test(rom.imageDigest ?? "")
          || (rom.runtimeImageDigest !== undefined || rom.androidSystemDigest !== undefined)
            && (!/^sha256:[a-f0-9]{64}$/.test(rom.runtimeImageDigest ?? "")
              || !/^sha256:[a-f0-9]{64}$/.test(rom.androidSystemDigest ?? "")
              || rom.runtimeImageDigest === rom.imageDigest)
          || rom.cameraSources!==undefined&&(!Array.isArray(rom.cameraSources)||rom.cameraSources.length<1
            ||rom.cameraSources.some(kind=>!['image','browser','video','usb','udp'].includes(kind))||new Set(rom.cameraSources).size!==rom.cameraSources.length))
        || new Set(node.roms.map(rom => rom.romVersionId)).size !== node.roms.length)) throw TypeError("Invalid installed phone ROM mappings");
    if (node.runtimeMaintenance !== undefined && (!Array.isArray(node.runtimeMaintenance)
        || node.runtimeMaintenance.some(value => !value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).some(key => !['phoneId','ownerId','volumeId','romVersionId','fromImageDigest','toImageDigest','androidSystemDigest','previousImageDigests'].includes(key))
          || ['phoneId','ownerId','volumeId'].some(key => !UUID.test(value[key] ?? ''))
          || !PHONE_ROM_ID.test(value.romVersionId ?? '')
          || ['fromImageDigest','toImageDigest','androidSystemDigest'].some(key => !/^sha256:[a-f0-9]{64}$/.test(value[key] ?? ''))
          || value.fromImageDigest === value.toImageDigest
          || value.previousImageDigests !== undefined && (!Array.isArray(value.previousImageDigests)
            || new Set(value.previousImageDigests).size !== value.previousImageDigests.length
            || value.previousImageDigests.some(image => !/^sha256:[a-f0-9]{64}$/.test(image)
              || image === value.toImageDigest || !node.roms?.some(rom => rom.imageDigest === image)))
          || !node.roms?.some(rom => rom.romVersionId === value.romVersionId && rom.imageDigest === value.fromImageDigest)
          || !node.roms?.some(rom => rom.imageDigest === value.toImageDigest))
        || new Set(node.runtimeMaintenance.map(value => value.phoneId)).size !== node.runtimeMaintenance.length)) {
      throw TypeError('Invalid phone host-runtime maintenance mappings');
    }
    return [node.nodeId, Object.freeze({ ...node,
      ...(node.runtimeMaintenance ? {runtimeMaintenance: Object.freeze(node.runtimeMaintenance.map(value => Object.freeze({...value,
        ...(value.previousImageDigests ? {previousImageDigests:Object.freeze([...value.previousImageDigests])} : {})})))} : {}),
      ...(node.roms ? { roms: Object.freeze(node.roms.map(rom => Object.freeze({ ...rom,
      ...(rom.cameraSources?{cameraSources:Object.freeze([...rom.cameraSources])}:{}) }))) } : {}) })];
  }));
  if (nodes.size !== value.length) throw new TypeError("Phone node IDs must be unique");
  return nodes;
}

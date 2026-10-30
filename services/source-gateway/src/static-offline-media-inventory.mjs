const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,126}[A-Za-z0-9]$/;
const FILESYSTEMS = new Set(["ext4", "xfs", "exfat"]);
const TRANSPORTS = new Set(["usb", "nvme", "sata"]);

function declaration(value, index) {
  if (!value || typeof value !== "object" || !UUID.test(value.nodeId ?? "") || !UUID.test(value.mountId ?? "")
      || !UUID.test(value.filesystemUuid ?? "") || !SHA256.test(value.deviceIdentitySha256 ?? "")
      || !FILESYSTEMS.has(value.filesystemType) || !TRANSPORTS.has(value.transport)
      || !LABEL.test(value.volumeLabel ?? "") || value.readOnly !== true || value.mountMode !== "read-only"
      || !Number.isSafeInteger(value.capacityBytes) || value.capacityBytes < 1) {
    throw new TypeError(`Offline media inventory declaration ${index} is invalid`);
  }
  return Object.freeze({
    nodeId: value.nodeId,
    mountId: value.mountId,
    filesystemUuid: value.filesystemUuid,
    deviceIdentitySha256: value.deviceIdentitySha256,
    filesystemType: value.filesystemType,
    transport: value.transport,
    volumeLabel: value.volumeLabel,
    capacityBytes: value.capacityBytes,
    readOnly: true,
    mountMode: "read-only",
  });
}

export class StaticOfflineMediaInventory {
  #media;
  constructor({ media }) {
    if (!Array.isArray(media)) throw new TypeError("Offline media inventory is invalid");
    this.#media = Object.freeze(media.map(declaration));
    const identities = new Set(this.#media.map((item) => item.deviceIdentitySha256));
    const mounts = new Set(this.#media.map((item) => `${item.nodeId}:${item.mountId}`));
    if (identities.size !== this.#media.length || mounts.size !== this.#media.length) {
      throw new TypeError("Offline media inventory contains duplicate identities");
    }
  }

  async listReadOnlyMedia({ nodeId }) {
    if (!UUID.test(nodeId ?? "")) throw new TypeError("Offline media node identity is invalid");
    return this.#media.filter((item) => item.nodeId === nodeId).map((item) => {
      const result = structuredClone(item);
      delete result.nodeId;
      return result;
    });
  }
}

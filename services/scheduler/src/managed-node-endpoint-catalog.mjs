const NODE_KEY = /^[a-z][a-z0-9_.-]{2,127}$/;
const HOST = /^(?:[A-Za-z0-9][A-Za-z0-9.-]{0,252}|[0-9a-fA-F:]{2,45})$/;

/** Immutable administrator-owned mapping from node certificate identity to its LAN control endpoint. */
export class ManagedNodeEndpointCatalog {
  #endpoints;

  constructor({ document }) {
    if (!document || typeof document !== "object" || Array.isArray(document)
        || document.schemaVersion !== 1 || Object.keys(document).some((key) => !new Set(["schemaVersion", "endpoints"]).has(key))
        || !Array.isArray(document.endpoints) || document.endpoints.length < 1 || document.endpoints.length > 256) {
      throw new TypeError("managed-node endpoint catalog is invalid");
    }
    const values = new Map();
    for (const endpoint of document.endpoints) {
      if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)
          || Object.keys(endpoint).sort().join(",") !== "host,nodeKey,port"
          || !NODE_KEY.test(endpoint.nodeKey ?? "") || !HOST.test(endpoint.host ?? "")
          || !Number.isSafeInteger(endpoint.port) || endpoint.port < 1024 || endpoint.port > 65535
          || values.has(endpoint.nodeKey)) {
        throw new TypeError("managed-node endpoint catalog entry is invalid");
      }
      values.set(endpoint.nodeKey, Object.freeze({ host: endpoint.host, port: endpoint.port }));
    }
    this.#endpoints = values;
  }

  resolve(nodeKey) {
    if (!NODE_KEY.test(nodeKey ?? "")) throw new TypeError("managed-node endpoint identity is invalid");
    const value = this.#endpoints.get(nodeKey);
    return value ? Object.freeze({ ...value }) : null;
  }
}

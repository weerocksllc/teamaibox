import { verify } from "node:crypto";

import { manifestSignaturePayload, validatePluginManifest } from "./manifest-validator.mjs";

export class PluginCompatibilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PluginCompatibilityError";
    this.code = code;
  }
}

function fail(code, message) { throw new PluginCompatibilityError(code, message); }

export class PluginCompatibilitySuiteV1 {
  #trustStore;
  #sandboxPolicy;
  #runtimeProbe;

  constructor({ trustStore, sandboxPolicy, runtimeProbe }) {
    if (!trustStore?.resolve || !sandboxPolicy?.compile || !runtimeProbe?.probe) {
      throw new TypeError("plugin compatibility suite dependencies are required");
    }
    this.#trustStore = trustStore;
    this.#sandboxPolicy = sandboxPolicy;
    this.#runtimeProbe = runtimeProbe;
  }

  async certify({ manifest }) {
    const identity = validatePluginManifest(manifest);
    const trust = await this.#trustStore.resolve(manifest.signature.keyId);
    if (!trust || trust.status !== "active" || trust.publisherId !== manifest.publisher.id
      || !verify(null, Buffer.from(manifestSignaturePayload(manifest), "utf8"), trust.publicKey, Buffer.from(manifest.signature.value, "base64"))) {
      fail("plugin_compatibility_signature_failed", "Plugin signature is not trusted");
    }
    const sandbox = await this.#sandboxPolicy.compile({
      manifest,
      pluginId: manifest.id,
      version: manifest.version,
      operationKey: `compatibility-${manifest.id}`,
    });
    if (sandbox.security.runAsUid === 0 || !sandbox.security.readOnlyRoot
      || !sandbox.security.dropAllCapabilities || !sandbox.security.noNewPrivileges
      || sandbox.security.dockerSocket || sandbox.filesystem.hostMounts.length) {
      fail("plugin_compatibility_sandbox_failed", "Plugin sandbox is weaker than the shared baseline");
    }
    const probe = await this.#runtimeProbe.probe({ manifest, sandbox });
    if (!probe || probe.health !== "passed" || probe.externalDependencies !== 0
      || probe.hostInterfaces !== 0 || probe.apiSurface !== "documented-v1") {
      fail("plugin_compatibility_runtime_failed", "Plugin runtime did not pass the shared compatibility probe");
    }
    if (manifest.type === "ApplicationPlugin"
      && (probe.delegatedUserApi !== true || probe.userTokenPersisted !== false || probe.devicesObserved !== 0)) {
      fail("plugin_compatibility_application_failed", "ApplicationPlugin access conformance failed");
    }
    if (manifest.type === "ComputePlugin"
      && (probe.workerControlV1 !== true || probe.schedulerOnlyRegistration !== true || probe.userTokenObserved !== false)) {
      fail("plugin_compatibility_compute_failed", "ComputePlugin control conformance failed");
    }
    return Object.freeze({
      suite: "teamaibox.plugin-compatibility/v1",
      policyClass: "uniform-official-and-third-party",
      pluginId: identity.pluginId,
      pluginType: identity.pluginType,
      version: identity.version,
      architecture: identity.architecture,
      signature: "passed",
      sandbox: "passed",
      runtime: "passed",
    });
  }
}

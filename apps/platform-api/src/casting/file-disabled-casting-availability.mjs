import { readFile } from "node:fs/promises";

import { PlatformError } from "../../../../packages/observability/src/index.mjs";

const CODE = /^[a-z][a-z0-9_]{2,127}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TOP_LEVEL_KEYS = new Set(["schemaVersion", "configurationId", "mode", "state", "claims", "outputs",
  "gates", "limitations", "sourceBindings", "successorPolicy"]);
const CLAIM_KEYS = new Set(["receiverReady", "sessionStartAllowed", "receiverAdvertisementAllowed",
  "productAccepted", "releaseEligible"]);
const REQUIRED_BLOCKERS = new Map([
  ["airplay_supply_chain_human_decisions_pending", "legal"],
  ["trusted_media_arm64_image_unbuilt", "supply_chain"],
  ["final_sbom_signature_provenance_and_vulnerability_evidence_missing", "supply_chain"],
  ["hdmi_sink_disconnected", "hardware"],
  ["hdmi_1080p30_not_proven", "hardware"],
  ["hdmi_audio_sink_not_proven", "hardware"],
  ["h264_encoder_plugin_missing", "runtime"],
  ["webrtc_plugin_missing", "runtime"],
  ["physical_apple_sender_not_exercised", "hardware"],
  ["seccomp_and_apparmor_real_runtime_not_exercised", "security"],
]);
const INTEGRATION_BLOCKERS = new Map([
  ["casting_product_service_not_deployed", "runtime"],
  ["casting_office_reservation_not_integrated", "runtime"],
  ["physical_apple_sender_not_exercised", "hardware"],
]);

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateBinding(value) {
  return exactKeys(value, new Set(["path", "sha256"]))
    && typeof value.path === "string" && value.path.length > 0 && !value.path.startsWith("/")
    && !value.path.split("/").includes("..")
    && DIGEST.test(value.sha256);
}

export function normalizeDisabledCastingAvailabilityConfiguration(value) {
  const integration = value?.schemaVersion === 2
    && value.configurationId === "teamaibox.wireless-casting-control-plane.disabled.v2";
  if (!exactKeys(value, TOP_LEVEL_KEYS) || (!integration && (value.schemaVersion !== 1
      || value.configurationId !== "teamaibox.wireless-casting-control-plane.disabled.v1"))
      || value.mode !== "disabled" || value.state !== "unsupported") {
    throw new TypeError("Disabled casting availability configuration is invalid");
  }
  if (!exactKeys(value.claims, CLAIM_KEYS) || Object.values(value.claims).some((claim) => claim !== false)) {
    throw new TypeError("Disabled casting availability configuration contains a positive claim");
  }
  if (!exactKeys(value.outputs, new Set(["hdmi", "browser"]))) {
    throw new TypeError("Disabled casting output availability is invalid");
  }
  const outputReasons = integration
    ? [["hdmi", "casting_product_service_not_deployed"], ["browser", "casting_product_service_not_deployed"]]
    : [["hdmi", "hdmi_sink_disconnected"], ["browser", "webrtc_plugin_missing"]];
  for (const [output, reasonCode] of outputReasons) {
    if (!exactKeys(value.outputs[output], new Set(["state", "reasonCode"]))
        || value.outputs[output].state !== "unavailable" || value.outputs[output].reasonCode !== reasonCode) {
      throw new TypeError(`Disabled casting ${output} output must remain unavailable`);
    }
  }
  const blockers = integration ? INTEGRATION_BLOCKERS : REQUIRED_BLOCKERS;
  if (!Array.isArray(value.gates) || value.gates.length !== blockers.size) {
    throw new TypeError("Disabled casting gate set is incomplete");
  }
  const gateCodes = new Set();
  for (const gate of value.gates) {
    if (!exactKeys(gate, new Set(["code", "category"])) || !CODE.test(gate.code)
        || blockers.get(gate.code) !== gate.category || gateCodes.has(gate.code)) {
      throw new TypeError("Disabled casting gate entry is invalid");
    }
    gateCodes.add(gate.code);
  }
  if (gateCodes.size !== blockers.size || [...blockers.keys()].some((code) => !gateCodes.has(code))) {
    throw new TypeError("Disabled casting gate set drifted");
  }
  if (!exactKeys(value.limitations, new Set(["appleCertified", "fairPlayDrmSupported", "syntheticAcceptanceAllowed"]))
      || Object.values(value.limitations).some((claim) => claim !== false)) {
    throw new TypeError("Disabled casting limitations are invalid");
  }
  const bindings = integration
    ? ["trustedMediaPackage", "supplyChainReview", "hardwareInventory", "hdmiComponent", "daemonComponent"]
    : ["trustedMediaPackage", "supplyChainReview", "hardwareInventory"];
  if (!exactKeys(value.sourceBindings, new Set(bindings))
      || Object.values(value.sourceBindings).some((binding) => !validateBinding(binding))) {
    throw new TypeError("Disabled casting source bindings are invalid");
  }
  if (!exactKeys(value.successorPolicy, new Set(["activation", "requiresReadyTrustedMediaRelease",
    "requiresSupportedHardwareEvidence", "requiresApprovedSupplyChainReview", "configurationAloneMayEnableReceiver"]))
      || value.successorPolicy.activation !== "atomic-platform-and-trusted-media-cutover"
      || value.successorPolicy.requiresReadyTrustedMediaRelease !== true
      || value.successorPolicy.requiresSupportedHardwareEvidence !== true
      || value.successorPolicy.requiresApprovedSupplyChainReview !== true
      || value.successorPolicy.configurationAloneMayEnableReceiver !== false) {
    throw new TypeError("Disabled casting successor policy is invalid");
  }
  return deepFreeze(structuredClone(value));
}

export class FileDisabledCastingAvailability {
  #publicStatus;

  constructor({ configuration }) {
    const value = normalizeDisabledCastingAvailabilityConfiguration(configuration);
    this.#publicStatus = deepFreeze({
      schemaVersion: 1,
      object: "cast.availability",
      mode: value.mode,
      state: value.state,
      receiverReady: false,
      sessionStartAllowed: false,
      receiverAdvertisementAllowed: false,
      outputs: {
        browser: { state: "unavailable", reasonCode: value.outputs.browser.reasonCode },
      },
      // Historical configuration remains validated unchanged. Retired physical
      // output checks are no longer requirements of the public browser feature.
      gates: value.gates.filter((gate) => !gate.code.startsWith("hdmi_")).map((gate) => ({ ...gate, state: "blocked" })),
      limitations: structuredClone(value.limitations),
      successor: { atomicCutoverRequired: true },
    });
  }

  static async fromFile(path) {
    if (typeof path !== "string" || !path.startsWith("/")) {
      throw new TypeError("PLATFORM_CASTING_AVAILABILITY_FILE must be an absolute path");
    }
    const value = JSON.parse(await readFile(path, "utf8"));
    return new FileDisabledCastingAvailability({ configuration: value });
  }

  status() {
    return this.#publicStatus;
  }

  assertSessionStartAllowed() {
    throw new PlatformError("cast_capability_unavailable", "Wireless casting is unavailable on this appliance", {
      status: 503,
      retryable: false,
      details: {
        state: this.#publicStatus.state,
        receiverReady: false,
        startAllowed: false,
        gateCodes: this.#publicStatus.gates.map((gate) => gate.code),
      },
    });
  }
}

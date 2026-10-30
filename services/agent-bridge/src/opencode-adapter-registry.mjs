import { PlatformError } from "../../../packages/observability/src/index.mjs";
import { OpenCodeV118Adapter, OPEN_CODE_V118_COMPATIBILITY } from "./opencode-adapter-v1-18.mjs";

export function createOpenCodeAdapter({ version, artifactDigest, ...options }) {
  if (version !== OPEN_CODE_V118_COMPATIBILITY.version
    || artifactDigest !== OPEN_CODE_V118_COMPATIBILITY.artifactDigest) {
    throw new PlatformError("opencode_version_unsupported", "OpenCode version or artifact digest is not supported", { status: 409 });
  }
  return new OpenCodeV118Adapter(options);
}

export function supportedOpenCodeAdapters() {
  return Object.freeze([OPEN_CODE_V118_COMPATIBILITY]);
}

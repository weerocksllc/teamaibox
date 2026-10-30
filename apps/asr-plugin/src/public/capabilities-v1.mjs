const WORD_TIMESTAMP_PROFILES_V1 = new Set([
  "asr.whisper-large-v3.fp16.spark-worker02.audio.v2",
]);
const SPEAKER_INFORMATION_PROFILES_V1 = new Set([
  "asr.whisper-small.ct2-int8.spark-local.sharded-diarization.experimental.a1",
]);

function activeProfiles(model) {
  if (!model || model.capabilityKey !== "asr" || model.available !== true) return [];
  const profiles = model.routingClass === "experimental"
    ? model.experimentalProfiles
    : model.certifiedProfiles;
  return Array.isArray(profiles) ? profiles.filter((value) => typeof value === "string" && value) : [];
}

export function asrCapabilitySnapshotV1(application) {
  const models = Array.isArray(application?.models) ? application.models : [];
  const model = models.find((item) => item?.capabilityKey === "asr" && item.available === true) ?? null;
  const profiles = activeProfiles(model);
  // Fail closed: a profile must be explicitly qualified before the UI may emit
  // word-level timestamp requests. Unknown and mixed routes remain segment-only.
  const wordTimestamps = profiles.length > 0 && profiles.every((profile) => WORD_TIMESTAMP_PROFILES_V1.has(profile));
  const selectedProfile = typeof model?.selectedProfile === "string" ? model.selectedProfile : null;
  const speakerInformation = selectedProfile !== null && SPEAKER_INFORMATION_PROFILES_V1.has(selectedProfile);
  return Object.freeze({
    experimental: model?.selectedCertificationState === "experimental" || model?.routingClass === "experimental",
    wordTimestamps, speakerInformation, selectedProfile,
    profiles: Object.freeze([...profiles]),
  });
}

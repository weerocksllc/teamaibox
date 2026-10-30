const FLUX2_NVFP4 = "drawing.flux2-klein-4b.nvfp4.spark23.provider.v1";
const QWEN_LIGHTNING = "drawing.qwen-image-2512-lightning.bf16.spark-worker02.v1";
const LONGCAT_IMAGE = "drawing.longcat-image.bf16.spark-worker02.v1";

const PROFILE_FACTS = Object.freeze({
  [FLUX2_NVFP4]: Object.freeze({
    profileId: "bc266009-bf57-589e-b8c4-dcf9ec892692",
    displayName: "FLUX.2 Klein 4B NVFP4",
    certificationState: "validating",
    precision: "nvfp4",
    exclusive: true,
    generation: true,
    editing: true,
    defaults: Object.freeze({ steps: 4, guidanceScale: 1, count: 1 }),
    constraints: Object.freeze({ negativePrompt: false, maskInpainting: false, maximumCount: 1,
      maximumReferenceImages: 4 }),
  }),
  [QWEN_LIGHTNING]: Object.freeze({
    profileId: "6e079903-18e3-5303-a742-d57054610520",
    displayName: "Qwen-Image-2512 Lightning BF16",
    certificationState: "validating",
    precision: "bf16",
    exclusive: true,
    generation: true,
    editing: false,
    defaults: Object.freeze({ steps: 4, guidanceScale: 1, count: 1 }),
    constraints: Object.freeze({ negativePrompt: true, maskInpainting: false, maximumCount: 1,
      maximumReferenceImages: 0, maximumWidth: 512, maximumHeight: 512 }),
  }),
  [LONGCAT_IMAGE]: Object.freeze({
    profileId: "d7558513-386f-51ee-8e78-8c4e18f6d3cf",
    displayName: "LongCat-Image BF16",
    certificationState: "validating",
    precision: "bf16",
    exclusive: true,
    generation: true,
    editing: false,
    defaults: Object.freeze({ steps: 50, guidanceScale: 4, count: 1 }),
    constraints: Object.freeze({ negativePrompt: false, maskInpainting: false, maximumCount: 1,
      maximumReferenceImages: 0, maximumWidth: 512, maximumHeight: 512 }),
  }),
});

const INTENTS = Object.freeze([
  Object.freeze({ intentKey: "automatic", modelAlias: "drawing.automatic", operation: "images.generations",
    profilePrefixes: [QWEN_LIGHTNING, FLUX2_NVFP4, "drawing.z-image-turbo."],
    reasonCode: "no_automatic_profile" }),
  Object.freeze({ intentKey: "fast", modelAlias: "drawing.fast", operation: "images.generations",
    profilePrefixes: [QWEN_LIGHTNING, FLUX2_NVFP4, "drawing.z-image-turbo."], reasonCode: "no_fast_profile" }),
  Object.freeze({ intentKey: "high-quality", modelAlias: "drawing.high-quality", operation: "images.generations",
    profilePrefixes: [LONGCAT_IMAGE, QWEN_LIGHTNING],
    reasonCode: "quality_profile_not_qualified" }),
  Object.freeze({ intentKey: "chinese-poster", modelAlias: "drawing.chinese-poster", operation: "images.generations",
    profilePrefixes: [LONGCAT_IMAGE, QWEN_LIGHTNING], reasonCode: "typography_profile_not_qualified" }),
  Object.freeze({ intentKey: "infographic", modelAlias: "drawing.infographic", operation: "images.generations",
    profilePrefixes: ["drawing.sensenova-u1.5-8b-mot."], reasonCode: "infographic_profile_not_qualified" }),
  Object.freeze({ intentKey: "editing", modelAlias: "drawing.edit", operation: "images.edits",
    profilePrefixes: [FLUX2_NVFP4], reasonCode: "editing_profile_not_qualified" }),
]);

function matchProfile(available, prefixes) {
  return prefixes.flatMap((prefix) => available.filter((profile) => profile === prefix || profile.startsWith(prefix)))[0] ?? null;
}

function profiles(compute, route) {
  const explicit = route === "local" ? compute?.localRoutableProfiles : compute?.providerRoutableProfiles;
  if (Array.isArray(explicit)) return explicit;
  if ((route === "local" && compute?.localRoute) || (route === "external" && compute?.providerRoute)) {
    return [...(compute?.certifiedProfiles ?? []), ...(compute?.experimentalProfiles ?? [])];
  }
  return [];
}

export function drawingIntentCatalogV1(compute) {
  const local = profiles(compute, "local");
  const external = profiles(compute, "external");
  const certified = new Set(compute?.certifiedProfiles ?? []);
  return Object.freeze({
    schema: "teamaibox.drawing-intents.v1",
    actualProfileDisclosureRequired: true,
    externalProcessingDisclosureRequired: true,
    intents: Object.freeze(INTENTS.map((intent) => {
      const localProfile = matchProfile(local, intent.profilePrefixes);
      const externalProfile = localProfile ? null : matchProfile(external, intent.profilePrefixes);
      const selectedProfile = localProfile ?? externalProfile;
      const facts = selectedProfile ? PROFILE_FACTS[selectedProfile] : null;
      const operationSupported = !facts
        || (intent.operation === "images.generations" ? facts.generation : facts.editing);
      const available = Boolean(selectedProfile && facts && operationSupported);
      return Object.freeze({
        intentKey: intent.intentKey,
        modelAlias: intent.modelAlias,
        operation: intent.operation,
        available,
        reasonCode: available ? null : intent.reasonCode,
        selectedProfile: available ? selectedProfile : null,
        selectedProfileId: available ? facts.profileId : null,
        selectedProfileDisplayName: available ? facts.displayName : null,
        certificationState: available ? (certified.has(selectedProfile) ? "certified" : facts.certificationState) : null,
        route: available ? (localProfile ? "local" : "external") : null,
        processingLocation: available ? (localProfile ? "appliance" : "managed_lan_node") : null,
        precision: available ? facts.precision : null,
        exclusive: available ? facts.exclusive : null,
        defaults: available ? facts.defaults : null,
        constraints: available ? facts.constraints : null,
      });
    })),
  });
}

export const drawingIntentProfilesV1 = PROFILE_FACTS;

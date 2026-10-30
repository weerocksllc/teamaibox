const FLUX2_MAIN_PROTECTED = "drawing.flux2-klein-4b.bf16.main-protected.v2";

const PROFILE_FACTS = Object.freeze({
  [FLUX2_MAIN_PROTECTED]: Object.freeze({
    profileId: "06c9542e-4bf3-5f4f-a41e-c7768398e2ea",
    displayName: "FLUX.2 Klein 4B Distilled BF16",
    certificationState: "validating",
    precision: "bf16",
    placementClass: "protected-resident",
    nodeRole: "main-box",
    exclusive: false,
    generation: true,
    editing: false,
    defaults: Object.freeze({ steps: 4, guidanceScale: 1, count: 1 }),
    constraints: Object.freeze({ negativePrompt: false, maskInpainting: false, maximumCount: 1,
      maximumReferenceImages: 0, maximumWidth: 512, maximumHeight: 512 }),
  }),

});

const ORDINARY_INTENTS = Object.freeze([
  Object.freeze({ intentKey: "automatic", modelAlias: "drawing.automatic", operation: "images.generations",
    reasonCode: "protected_office_profile_unavailable" }),
  Object.freeze({ intentKey: "fast", modelAlias: "drawing.fast", operation: "images.generations",
    reasonCode: "protected_office_profile_unavailable" }),
]);


function profiles(compute) {
  const explicit = compute?.localActuallyRoutableProfiles;
  if (!Array.isArray(explicit)) return [];
  const eligible = new Set([...(compute?.certifiedProfiles ?? []), ...(compute?.experimentalProfiles ?? [])]);
  return [...new Set(explicit.filter((profile) => typeof profile === "string" && eligible.has(profile)))];
}


function unavailable(intent) {
  return Object.freeze({
    intentKey: intent.intentKey,
    modelAlias: intent.modelAlias,
    operation: intent.operation,
    available: false,
    reasonCode: intent.reasonCode,
    selectedProfile: null,
    selectedProfileId: null,
    selectedProfileDisplayName: null,
    certificationState: null,
    route: null,
    processingLocation: null,
    precision: null,
    placementClass: null,
    nodeRole: null,
    exclusive: null,
    defaults: null,
    constraints: null,
  });
}

function selected(intent, profileKey, facts, { route, certified }) {
  const generation = intent.operation === "images.generations";
  const placementMatchesRoute = route === "local" && facts?.placementClass === "protected-resident" && facts?.nodeRole === "main-box";
  if (!facts || !placementMatchesRoute || (generation ? !facts.generation : !facts.editing)) return unavailable(intent);
  return Object.freeze({
    intentKey: intent.intentKey,
    modelAlias: intent.modelAlias,
    operation: intent.operation,
    available: true,
    reasonCode: null,
    selectedProfile: profileKey,
    selectedProfileId: facts.profileId,
    selectedProfileDisplayName: facts.displayName,
    certificationState: certified ? "certified" : facts.certificationState,
    route,
    processingLocation: "appliance",
    precision: facts.precision,
    placementClass: facts.placementClass,
    nodeRole: facts.nodeRole,
    exclusive: facts.exclusive,
    defaults: facts.defaults,
    constraints: facts.constraints,
  });
}

export function drawingIntentCatalogV2(compute, { ordinaryProfile = null } = {}) {
  const local = profiles(compute);
  const certified = new Set(compute?.certifiedProfiles ?? []);
  const profileKey = ordinaryProfile?.profileKey ?? FLUX2_MAIN_PROTECTED;
  const profileId = ordinaryProfile?.profileId ?? PROFILE_FACTS[FLUX2_MAIN_PROTECTED].profileId;
  const ordinaryFacts = { ...PROFILE_FACTS[FLUX2_MAIN_PROTECTED], profileId };
  const protectedHealthy = local.includes(profileKey)
    && /^drawing\.flux2-klein-4b\.bf16\.main-protected\./.test(profileKey)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(profileId);
  const ordinary = ORDINARY_INTENTS.map((intent) => protectedHealthy
    ? selected(intent, profileKey, ordinaryFacts, {
      route: "local", certified: certified.has(profileKey),
    })
    : unavailable(intent));
  return Object.freeze({
    schema: "teamaibox.drawing-intents.v2",
    policyVersion: "protected-main-default.v1",
    actualProfileDisclosureRequired: true,
    externalProcessingDisclosureRequired: false,
    ordinaryPolicy: Object.freeze({
      fallbackAllowed: false,
      requiredPlacementClass: "protected-resident",
      requiredNodeRole: "main-box",
      selectedProfile: protectedHealthy ? profileKey : null,
      selectedProfileId: protectedHealthy ? profileId : null,
    }),
    intents: Object.freeze(ordinary),
  });
}

export const drawingIntentProfilesV2 = PROFILE_FACTS;
export const drawingOrdinaryProfileV2 = FLUX2_MAIN_PROTECTED;

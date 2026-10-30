const ORDINARY_KEYS = Object.freeze(["automatic", "fast"]);
const OPERATIONS = new Set(["images.generations"]);
const ROUTES = new Set(["local"]);
const PLACEMENTS = new Set(["protected-resident"]);
const CERTIFICATION_STATES = new Set(["certified", "validating", "experimental"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INTENT_ALIASES = Object.freeze({ automatic: "drawing.automatic", fast: "drawing.fast" });
const INTENT_OPERATIONS = Object.freeze({ automatic: "images.generations", fast: "images.generations" });
function validDefaults(value) {
  return value && Number.isSafeInteger(value.steps) && value.steps > 0
    && Number.isFinite(value.guidanceScale) && value.guidanceScale >= 0
    && Number.isSafeInteger(value.count) && value.count > 0;
}

function validConstraints(value, defaults) {
  if (!value || typeof value.negativePrompt !== "boolean" || typeof value.maskInpainting !== "boolean"
      || !Number.isSafeInteger(value.maximumCount) || value.maximumCount < defaults.count
      || !Number.isSafeInteger(value.maximumReferenceImages) || value.maximumReferenceImages < 0) return false;
  return ["maximumWidth", "maximumHeight"].every((key) => value[key] === undefined
    || (Number.isSafeInteger(value[key]) && value[key] > 0));
}

function parseIntent(item, expectedKey) {
  if (!item || item.intentKey !== expectedKey || item.modelAlias !== INTENT_ALIASES[expectedKey]
      || !OPERATIONS.has(item.operation) || item.operation !== INTENT_OPERATIONS[expectedKey]) return null;
  if (item.available === true) {
    if (item.reasonCode !== null || typeof item.selectedProfile !== "string" || !item.selectedProfile || !UUID.test(item.selectedProfileId)
        || typeof item.selectedProfileDisplayName !== "string" || item.selectedProfileDisplayName.length === 0
        || !CERTIFICATION_STATES.has(item.certificationState)
        || !ROUTES.has(item.route) || !PLACEMENTS.has(item.placementClass)
        || typeof item.precision !== "string" || item.precision.length === 0 || typeof item.exclusive !== "boolean"
        || !validDefaults(item.defaults) || !validConstraints(item.constraints, item.defaults)) return null;
    if ((item.operation !== "images.generations" || item.route !== "local" || item.processingLocation !== "appliance"
        || item.placementClass !== "protected-resident" || item.nodeRole !== "main-box" || item.exclusive !== false)) return null;
  } else if (item.available !== false || typeof item.reasonCode !== "string"
      || item.selectedProfile !== null || item.selectedProfileId !== null || item.route !== null
      || item.selectedProfileDisplayName !== null || item.certificationState !== null
      || item.processingLocation !== null || item.precision !== null || item.placementClass !== null
      || item.nodeRole !== null || item.exclusive !== null || item.defaults !== null || item.constraints !== null) return null;
  return Object.freeze(structuredClone(item));
}

export function parseDrawingIntentRouterV2(application) {
  const model = application?.models?.find((item) => item.capabilityKey === "image-generation");
  const router = model?.intentRouter;
  if (router?.schema !== "teamaibox.drawing-intents.v2" || router.policyVersion !== "protected-main-default.v1"
      || router.actualProfileDisclosureRequired !== true || router.externalProcessingDisclosureRequired !== false
      || router.ordinaryPolicy?.fallbackAllowed !== false
      || router.ordinaryPolicy?.requiredPlacementClass !== "protected-resident"
      || router.ordinaryPolicy?.requiredNodeRole !== "main-box"
      || !Array.isArray(router.intents)
      || router.intents.map((item) => item.intentKey).join("|") !== ORDINARY_KEYS.join("|")) return null;
  const ordinary = router.intents.map((item, index) => parseIntent(item, ORDINARY_KEYS[index]));
  if (ordinary.includes(null)) return null;
  if (ordinary.some((item) => item.available) !== ordinary.every((item) => item.available)) return null;
  const selectedOrdinary = ordinary.find((item) => item.available)?.selectedProfile ?? null;
  const selectedOrdinaryId = ordinary.find((item) => item.available)?.selectedProfileId ?? null;
  if (router.ordinaryPolicy.selectedProfile !== selectedOrdinary
      || router.ordinaryPolicy.selectedProfileId !== selectedOrdinaryId
      || ordinary.filter((item) => item.available).some((item) => item.selectedProfile !== selectedOrdinary
        || item.selectedProfileId !== selectedOrdinaryId)) return null;
  return Object.freeze({
    schema: router.schema,
    policyVersion: router.policyVersion,
    route: model.route,
    routingClass: model.routingClass,
    available: model.available === true,
    ordinaryPolicy: Object.freeze(structuredClone(router.ordinaryPolicy)),
    intents: Object.freeze(ordinary),
  });
}

export function preferredDrawingIntentV2(router, currentIntentKey = null) {
  const retained = router?.intents?.find((item) => item.intentKey === currentIntentKey && item.available === true);
  return retained ?? router?.intents?.find((item) => item.intentKey === "automatic" && item.available === true) ?? null;
}

export const drawingIntentKeysV2 = ORDINARY_KEYS;

const LEGACY = "aosp-17-16102939-v1";
const GOOGLE = "google-experimental-17-16102939-v1";
const rendered = new WeakMap();
const TYPES = [{systemId:'standard',familyId:'aosp',googlePlay:false},
  {systemId:'google-play',familyId:'google-experimental',googlePlay:true}];
// Keep an older API usable during ordered rollout without exposing its internal
// build history. Do not guess that the latest Camera version is published.
export function phoneRomChoices(availability) {
  return TYPES.map(type => {
    const id=type.googlePlay ? GOOGLE : availability?.defaultRomVersionId ?? LEGACY;
    const candidates=availability?.systems
      ? availability.systems.filter(rom=>rom.systemId===type.systemId && rom.familyId===type.familyId && rom.googlePlay===type.googlePlay)
      : (availability?.roms ?? [{id:LEGACY,familyId:'aosp',googlePlay:false,createEnabled:true}])
        .filter(rom=>rom.id===id && rom.familyId===type.familyId && rom.googlePlay===type.googlePlay);
    const rom=candidates.length===1 ? candidates[0] : null;
    return {...rom,...type,id:rom?.id ?? id,createEnabled:Boolean(rom?.createEnabled),
      reasonCode:rom?.reasonCode ?? (rom ? null : 'phone_rom_unavailable')};
  });
}
export function phoneRomDescription(rom, t) {
  return `${t(rom?.googlePlay ? 'romGoogleName' : 'romStandardName')}${rom?.googlePlay && rom.experimental ? ` · ${t('romExperimental')}` : ''}`;
}
export function renderPhoneRoms(element, availability, t, { preserve = true } = {}) {
  const previous = preserve ? element.querySelector("input:checked")?.value : null;
  const choices = phoneRomChoices(availability), preferred = previous ?? availability?.defaultRomVersionId ?? LEGACY;
  const signature = JSON.stringify([choices,availability?.defaultRomVersionId,t("romTitle")]);
  if(preserve && rendered.get(element)===signature)return;
  rendered.set(element,signature);
  element.replaceChildren(...choices.map(rom => {
    const label = document.createElement("label"), input = document.createElement("input"), body = document.createElement("span");
    label.className = "rom-choice"; input.type = "radio"; input.name = "romVersionId"; input.value = rom.id;
    input.required = true; input.disabled = !rom.createEnabled || Boolean(rom.reasonCode);
    input.checked = rom.id === preferred && !input.disabled;
    const title = document.createElement("strong"), version = document.createElement("small"), hint = document.createElement("small");
    title.textContent = t(rom.googlePlay ? 'romGoogleName' : 'romStandardName');
    version.textContent = t(rom.googlePlay ? 'romPlay' : 'romNoPlay');
    hint.textContent = input.disabled ? t(rom.reasonCode || "phone_rom_unavailable")
      : `${t(rom.googlePlay ? "romPlayHint" : "romAospHint")}${rom.experimental ? ` · ${t("romExperimental")}` : ""}`;
    body.append(title, version, hint);
    const camera=document.createElement('small');
    camera.textContent=t(rom.cameraCapability==='verified' ? 'romCameraSettings' : 'romCameraPending');
    body.append(camera);label.append(input, body); label.dataset.disabled = String(input.disabled);
    label.dataset.system=rom.systemId;
    return label;
  }));
}

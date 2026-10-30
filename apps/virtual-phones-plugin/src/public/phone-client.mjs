const ROOT = "/api/v1/virtual-phones";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PHONE_STATES = ["creating", "stopped", "starting", "running", "stopping", "unavailable", "error", "deleting", "deleted"];
export const TRANSIENT = new Set(["creating", "starting", "stopping", "deleting"]);
export class PhoneApiError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
const invalid = () => { throw new PhoneApiError("phone_response_invalid", 502); };
const id = value => { if (!UUID.test(value ?? "")) invalid(); return value; };
function normalizeRom(value) {
  if(!value || !/^[a-z][a-z0-9.-]{2,127}$/.test(value.id??"") || !["aosp","google-experimental"].includes(value.familyId)
    || typeof value.name!=="string" || typeof value.version!=="string"
    || typeof value.googlePlay!=="boolean" || typeof value.experimental!=="boolean"
    || !["unavailable","verified"].includes(value.cameraCapability))invalid();
  return {id:value.id,familyId:value.familyId,name:value.name,version:value.version,googlePlay:value.googlePlay,
    experimental:value.experimental,cameraCapability:value.cameraCapability};
}
function normalizeCamera(value,generation){
  if(value===undefined)return null;
  if(!value||value.generation!==generation||!['stopped','starting','active','stopping'].includes(value.state))invalid();
  if(value.state==='stopped')return {state:'stopped',generation};
  if(!UUID.test(value.sourceId??'')||!['image','browser','video','usb','udp'].includes(value.sourceKind))invalid();
  return {state:value.state,generation,sourceId:value.sourceId,sourceKind:value.sourceKind};
}
export function normalizePhone(value) {
  if (value?.object !== "virtual_phone" || !UUID.test(value.id ?? "") || typeof value.name !== "string"
    || !value.name.trim() || !PHONE_STATES.includes(value.state) || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.runningCharged !== "boolean") invalid();
  return { id: value.id, name: value.name, state: value.state, revision: value.revision, runningCharged: value.runningCharged,
    generation:Number.isSafeInteger(value.generation)&&value.generation>=0?value.generation:null,
    rom:value.rom?normalizeRom(value.rom):null,
    cleanupMode:value.cleanupMode === 'retired-record' ? 'retired-record' : 'delete-data',
    cameraInput:normalizeCamera(value.cameraInput,value.generation),
    errorCode: typeof value.errorCode === "string" ? value.errorCode : null };
}
export function phoneActions(phone, canStart) {
  if (TRANSIENT.has(phone.state) || phone.state === "deleted") return [];
  if (phone.cleanupMode === 'retired-record' && !phone.runningCharged) return ['rename', 'remove-record'];
  const actions = [];
  if (["stopped", "error"].includes(phone.state) && !phone.runningCharged && canStart) actions.push("start");
  if (["running", "error", "unavailable"].includes(phone.state) && phone.runningCharged) actions.push("stop");
  if (phone.state === "running" && canStart) actions.push("restart");
  actions.push("rename", "delete");
  return actions;
}
export function createPhoneApi({ fetchImpl = globalThis.fetch, cookie = () => globalThis.document?.cookie ?? "" } = {}) {
  async function request(path, { method = "GET", body, key } = {}) {
    if (!(path === ROOT || path.startsWith(ROOT + "/")) || /[?#]/.test(path)) invalid();
    const headers = { accept: "application/json" };
    if (method !== "GET") {
      const tokens = cookie().split(";").map(s => s.trim()).filter(s => s.startsWith("__Host-teamaibox-csrf="));
      if (tokens.length !== 1 || !tokens[0].split("=")[1]) throw new PhoneApiError("invalid_session", 401);
      headers["x-csrf-token"] = tokens[0].slice(tokens[0].indexOf("=") + 1);
      headers["content-type"] = "application/json";
      if (key) headers["idempotency-key"] = key;
    }
    let response;
    try { response = await fetchImpl(path, { method, headers, credentials: "same-origin", cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) }); }
    catch { throw new PhoneApiError("phone_network_unavailable"); }
    let value;
    try {
      if (!response.headers.get("content-type")?.includes("application/json")) invalid();
      value = await response.json();
    } catch { invalid(); }
    if (!response.ok) throw new PhoneApiError(typeof value?.error?.code === "string" ? value.error.code : "phone_request_failed", response.status);
    return value;
  }
  return {
    async list() {
      const result = await request(ROOT), quota = result?.quota;
      if (result?.object !== "list" || !Array.isArray(result.data)
        || ["stored", "running"].some(k => !Number.isSafeInteger(quota?.[k]) || quota[k] < 0)
        || ["storedPerUser", "runningPerUser"].some(k => quota?.[k] !== null && (!Number.isSafeInteger(quota?.[k]) || quota[k] < 0))) invalid();
      return { data: result.data.map(normalizePhone), quota };
    },
    async availability() { const value = await request(ROOT + "/availability");
      if (value?.object !== "virtual_phone.availability" || typeof value.enabled !== "boolean" || typeof value.runtimeConfigured !== "boolean") invalid();
      if(value.roms!==undefined){
        if(!Array.isArray(value.roms))invalid();
        value.roms=value.roms.map(rom=>{const normalized=normalizeRom(rom);if(typeof rom.createEnabled!=="boolean" || rom.reasonCode!==null && !["phone_rom_unavailable","phone_rom_not_installed"].includes(rom.reasonCode))invalid();return {...normalized,createEnabled:rom.createEnabled,reasonCode:rom.reasonCode};});
        if(new Set(value.roms.map(rom=>rom.id)).size!==value.roms.length)invalid();
      }
      return value; },
    async connection(phoneId,{takeover=false}={}) {
      if(typeof takeover!=="boolean")invalid();
      const value=await request(`${ROOT}/${id(phoneId)}/connections`,{method:"POST",body:{kind:"control",ttlSeconds:60,takeover}});
      if(value?.object!=="virtual_phone.connection_ticket" || value.phoneId!==phoneId || !UUID.test(value.id ?? "")
        || value.kind!=="control" || !/^[A-Za-z0-9_-]{43}$/.test(value.token ?? ""))invalid();
      return value;
    },
    async closeConnection(phoneId,grantId) {
      return request(`${ROOT}/${id(phoneId)}/connections/${id(grantId)}`,{method:"DELETE",body:{}});
    },
    async enableDebug(phoneId) {
      const value=await request(`${ROOT}/${id(phoneId)}/adb-grants`,{method:"POST",body:{ttlSeconds:900}});
      const expires=Date.parse(value?.expiresAt),connectionExpires=Date.parse(value?.connectionExpiresAt);
      if(value?.object!=="virtual_phone.connection_ticket" || value.phoneId!==phoneId || !UUID.test(value.id??"")
        || value.kind!=="adb" || !/^[A-Za-z0-9_-]{43}$/.test(value.token??"") || !Number.isFinite(expires)
        || !Number.isFinite(connectionExpires) || connectionExpires>expires || connectionExpires<=Date.now()
        || expires>Date.now()+901000 || connectionExpires>Date.now()+61000)invalid();
      return value;
    },
    async disableDebug(phoneId,grantId) {
      return request(`${ROOT}/${id(phoneId)}/adb-grants/${id(grantId)}`,{method:"DELETE",body:{}});
    },
    async mutate({ action, phoneId, body, key }) {
      const path = action === "create" ? ROOT : `${ROOT}/${id(phoneId)}${["start", "stop", "restart", "remove-record"].includes(action) ? "/" + action : ""}`;
      if (!["create", "rename", "delete", "start", "stop", "restart", "remove-record"].includes(action)) invalid();
      const method = action === "delete" ? "DELETE" : action === "rename" ? "PATCH" : "POST";
      const value = await request(path, { method, body, key });
      if (action === "rename") return normalizePhone(value);
      if (action === 'remove-record') {
        if (value.id !== phoneId || value.recordRemoved !== true || value.dataDeleted !== false) invalid();
        return value;
      }
      if (value?.object !== "virtual_phone.operation" || !UUID.test(value.id ?? "") || !UUID.test(value.phoneId ?? "")) invalid();
      return value;
    },
    async operation(operationId) { return request(`${ROOT}/operations/${id(operationId)}`); },
  };
}

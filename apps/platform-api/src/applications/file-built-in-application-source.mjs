import { readFile } from "node:fs/promises";

const KEY = /^[a-z][a-z0-9_.-]{1,127}$/;
const PROFILE_KEY = /^[a-z][a-z0-9_.-]{2,191}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[+.-][0-9A-Za-z.-]+)?$/;

export class FileBuiltInApplicationSource {
  #path;
  constructor({ path }) {
    if (typeof path !== "string" || !path.startsWith("/")) throw new TypeError("Built-in application file must use an absolute path");
    this.#path = path;
  }
  async applications() {
    const value = JSON.parse(await readFile(this.#path, "utf8"));
    if (value?.schemaVersion !== 1 || !Array.isArray(value.applications)) throw new TypeError("Built-in application file is invalid");
    const seen = new Set();
    return Object.freeze(value.applications.map((application) => {
      if (!KEY.test(application?.applicationKey) || seen.has(application.applicationKey)
          || !VERSION.test(application?.installedVersion)
          || application?.route?.integration !== "workbench"
          || application.route.pathPrefix !== `/apps/${application.applicationKey.split(".").at(-1)}`
          || !Array.isArray(application.requiredPermissions)
          || !Array.isArray(application.requiredCapabilities)
          || !Array.isArray(application.requiredCoreServices)
          || !application.ui) throw new TypeError("Built-in application entry is invalid");
      const requiredModelProfiles = application.requiredModelProfiles ?? {};
      if (!requiredModelProfiles || typeof requiredModelProfiles !== "object" || Array.isArray(requiredModelProfiles)
          || Object.entries(requiredModelProfiles).some(([capabilityKey, profileKey]) =>
            !application.requiredCapabilities.includes(capabilityKey) || !PROFILE_KEY.test(profileKey))) {
        throw new TypeError("Built-in application model profile requirements are invalid");
      }
      seen.add(application.applicationKey);
      return Object.freeze(structuredClone(application));
    }));
  }
}

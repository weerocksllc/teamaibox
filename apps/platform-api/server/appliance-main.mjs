import { pathToFileURL } from 'node:url';
import { startPlatformApiProcess, protectedOfficeSetRuntimeRequested } from './main.mjs';
import { applianceConfiguration } from './appliance-runtime.mjs';

export async function startApplianceApiProcess(environment = process.env, options = {}) {
  applianceConfiguration(environment);
  if (environment.PLATFORM_API_PERSISTENCE !== 'postgres') throw new TypeError('Installed appliance requires PostgreSQL persistence');
  if (protectedOfficeSetRuntimeRequested(environment)) {
    throw new TypeError('Historical protected-office acceptance configuration is not supported by the appliance entry point; remove v5 bundle, probe and scenario settings from the installation environment');
  }
  if (environment.PLATFORM_PROTECTED_OFFICE_SET_NODE_ID
      && environment.PLATFORM_PROTECTED_OFFICE_SET_NODE_ID !== environment.PLATFORM_APPLIANCE_NODE_ID) {
    throw new TypeError('Protected office set must belong to this appliance');
  }
  return startPlatformApiProcess(environment, options);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  startApplianceApiProcess().catch(error => {
    console.error('Appliance API startup failed:', error.message);
    process.exitCode = 1;
  });
}

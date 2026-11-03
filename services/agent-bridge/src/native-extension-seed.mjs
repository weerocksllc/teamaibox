import {access,cp,lstat,mkdir,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';

/** Initialize only absent native SDK dependencies, never user configuration.
 * The existing per-user lifecycle guarantees one writer at startup. */
export async function seedNativeExtensionRuntime(source,destination) {
  const exists=async path=>{try{await lstat(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
  await mkdir(destination,{recursive:true,mode:0o700});
  // A user-owned package manifest is authoritative. Do not merge or replace it.
  for(const name of ['package.json','package-lock.json','node_modules'])if(await exists(join(destination,name)))return false;
  await access(join(source,'node_modules/@opencode-ai/plugin/package.json'));
  const staging=join(destination,'.teamaibox-native-sdk-staging');
  if(await exists(staging))throw Error('native_extension_initialization_incomplete');
  await mkdir(staging,{mode:0o700});
  try{
    for(const name of ['package.json','package-lock.json','node_modules'])await cp(join(source,name),join(staging,name),{recursive:true,force:false,errorOnExist:true});
    // Publish the manifest last. Nothing above touches opencode.json or Skills.
    for(const name of ['node_modules','package-lock.json','package.json'])await rename(join(staging,name),join(destination,name));
  }finally{
    // This function created this exact staging directory; no user path removed.
    await rm(staging,{recursive:true,force:true});
  }
  return true;
}

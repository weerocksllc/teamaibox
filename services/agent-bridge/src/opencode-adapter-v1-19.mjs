import {OpenCodeV118Adapter} from './opencode-adapter-v1-18.mjs';

// v1.19.5 retains these legacy HTTP operations. New frontend features use the
// native transport instead; this adapter preserves existing history readers.
export const OPEN_CODE_V119_COMPATIBILITY=Object.freeze({
  adapterKey:'opencode.http.v1.19',
  version:'1.19.5',
  artifactDigest:'sha256:fae5be262d693b7c5e562856cc473e59e741772936db0c0600ac0d5ed5bd088b',
});
export class OpenCodeV119Adapter extends OpenCodeV118Adapter {
  get compatibility(){return OPEN_CODE_V119_COMPATIBILITY;}
}

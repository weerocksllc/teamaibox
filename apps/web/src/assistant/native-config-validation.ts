import {parse,type ParseError} from 'jsonc-parser';
import validate from './native-config-validator.mjs';

/** Pinned native schema validation for the form, not an execution/config engine.
 * Leave source bytes/comments intact; errors never echo configuration values. */
export function validateNativeConfig(source:string,jsonc=false){
  const errors:ParseError[]=[];
  const value:unknown=parse(source,errors,{allowTrailingComma:jsonc,disallowComments:!jsonc,allowEmptyContent:false});
  if(errors.length)throw Error(`configuration_syntax_error_at_${errors[0].offset}`);
  if(!validate(value)){
    const error=validate.errors?.[0];
    throw Error(`configuration_invalid_${error?.keyword??'schema'}${error?.instancePath??''}`);
  }
  return value;
}

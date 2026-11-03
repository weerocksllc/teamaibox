/** An explicit selection or native effective default, never catalog order. */
export function nativeModelChoice(selection:string,configured?:string) {
  const delimiter=selection?'\n':'/';
  const value=selection||configured||'';const at=value.indexOf(delimiter);
  if(at<=0||at===value.length-1)throw new Error('native_default_model_unavailable');
  const providerID=value.slice(0,at),modelID=value.slice(at+1);
  if(/[\s\0]/.test(providerID)||/[\r\n\0]/.test(modelID))throw new Error('native_default_model_unavailable');
  return {providerID,modelID};
}

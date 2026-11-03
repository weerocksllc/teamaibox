/** Native PTY cursor units are UTF-16 string length, not UTF-8 byte length. */
export function decodeTerminalFrame(data:string|ArrayBuffer):{text?:string;cursor?:number} {
  if(typeof data==='string')return {text:data};
  const bytes=new Uint8Array(data);
  if(bytes[0]===0){
    const meta=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(1)));
    if(!Number.isSafeInteger(meta.cursor)||meta.cursor<0)throw new TypeError('Invalid terminal cursor');
    return {cursor:meta.cursor};
  }
  return {text:new TextDecoder('utf-8',{fatal:true}).decode(bytes)};
}

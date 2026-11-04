export const MEDIA_PREVIEW_BYTES=16*1024*1024;
const raster=new Set(['image/png','image/jpeg','image/gif','image/webp']);
export type MediaSource={kind:'workspace';path:string}|{kind:'data';mime:string;body:string}|{kind:'external';url:string;host:string}|{kind:'unavailable'};
/** Resolve only inside this owner's workspace; never create a browser file: URL. */
export function mediaSource(source:string,directory:string):MediaSource{
  if(!source||source.length>MEDIA_PREVIEW_BYTES*1.4||/[\u0000-\u001f\u007f\\]/.test(source))return {kind:'unavailable'};
  if(source.startsWith('data:')){
    const match=/^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(source);
    if(!match||match[2].length%4||match[2].length>Math.ceil(MEDIA_PREVIEW_BYTES/3)*4)return {kind:'unavailable'};
    return {kind:'data',mime:match[1].toLowerCase(),body:match[2]};
  }
  if(/^https?:/i.test(source)){
    try{const url=new URL(source);if(url.username||url.password)return {kind:'unavailable'};return {kind:'external',url:url.href,host:url.host};}catch{return {kind:'unavailable'};}
  }
  if(source.startsWith('//')||!(directory==='/workspace'||directory.startsWith('/workspace/')))return {kind:'unavailable'};
  try{
    const decoded=decodeURIComponent(source);
    if(/[\u0000-\u001f\u007f\\%]/.test(decoded)||decoded.startsWith('//'))return {kind:'unavailable'};
    if(/^[a-z][a-z\d+.-]*:/i.test(decoded)&&!decoded.startsWith('file:'))return {kind:'unavailable'};
    const url=new URL(decoded,'file://'+directory.replace(/\/$/,'')+'/');
    if(url.protocol!=='file:'||url.host||url.search||url.hash)return {kind:'unavailable'};
    const path=decodeURIComponent(url.pathname);
    if(!path.startsWith('/workspace/')||path.split('/').some(p=>p==='.teamaibox'||p==='.git'))return {kind:'unavailable'};
    return {kind:'workspace',path:path.slice('/workspace/'.length)};
  }catch{return {kind:'unavailable'};}
}
export function dataBytes(source:Extract<MediaSource,{kind:'data'}>){
  const raw=atob(source.body);if(raw.length>MEDIA_PREVIEW_BYTES)throw Error('media_too_large');
  const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
  if(btoa(raw)!==source.body)throw Error('media_encoding_invalid');return bytes;
}
export function rasterMime(bytes:Uint8Array){
  if(bytes.length>=8&&[137,80,78,71,13,10,26,10].every((n,i)=>bytes[i]===n))return 'image/png';
  if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
  const head=String.fromCharCode(...bytes.slice(0,12));
  if(head.startsWith('GIF87a')||head.startsWith('GIF89a'))return 'image/gif';
  if(head.startsWith('RIFF')&&head.slice(8)==='WEBP')return 'image/webp';return null;
}
export function safeRaster(bytes:Uint8Array,declared?:string){
  const mime=rasterMime(bytes);if(!mime||(declared&&(!raster.has(declared)||mime!==declared)))throw Error('media_type_unsupported');return mime;
}
export function safeMessageLink(href:string|undefined){
  if(!href||/[\u0000-\u0020\u007f\\]/.test(href))return undefined;
  try{const u=new URL(href);return ['https:','http:','mailto:'].includes(u.protocol)&&!u.username&&!u.password?u.href:undefined;}catch{return undefined;}
}

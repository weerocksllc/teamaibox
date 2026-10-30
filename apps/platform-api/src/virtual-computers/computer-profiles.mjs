import {createHash} from 'node:crypto';
import {computerError,validateComputerProfile} from './lifecycle.mjs';

const object=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const text=v=>typeof v==='string'&&v.trim()===v&&v.length>0&&!/[\u0000-\u001f\u007f]/u.test(v);
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const profileRevision=row=>createHash('sha256').update(JSON.stringify(canonical({profile:row.profile,createEnabled:row.create_enabled}))).digest('hex');

// Import describes already obtained installation media; it is not an arbitrary
// host download, Docker command, license grant or replacement of an existing VM.
export function profileImport(input){
  if(!object(input,['profile']))computerError('computer_input_invalid',400);
  const p=validateComputerProfile(input.profile);
  if(!/^[a-z0-9][a-z0-9._-]*$/.test(p.id)||!['name','version','edition'].every(k=>text(p[k]))
    ||!object(p.minimum,['vcpus','memoryGiB','diskGiB'])
    ||!object(p.rights,['activationRequired','redistributionAllowed','remoteUseLicenseRequired','environment'])
    ||!['activationRequired','redistributionAllowed','remoteUseLicenseRequired'].every(k=>typeof p.rights[k]==='boolean')
    ||!['development','production'].includes(p.rights.environment))computerError('computer_input_invalid',400);
  return p;
}
export function profilePublication(input){
  if(!object(input,['enabled','expectedRevision'])||typeof input.enabled!=='boolean'
    ||!/^[a-f0-9]{64}$/.test(input.expectedRevision??''))computerError('computer_input_invalid',400);
  return {...input};
}
export function publicProfile(row){
  return {id:row.profile.id,name:row.profile.name,version:row.profile.version,edition:row.profile.edition,
    minimum:row.profile.minimum,rights:row.profile.rights,createEnabled:row.create_enabled,revision:profileRevision(row)};
}

import {computerError,computerId} from './lifecycle.mjs';
const object=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
const count=v=>v===null||Number.isSafeInteger(v)&&v>=0;
export function quotaUpdate(input) {
  if(!object(input,['storedPerUser','runningPerUser','expectedRevision'])||!count(input.storedPerUser)||!count(input.runningPerUser)
    ||!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0
    ||input.storedPerUser!==null&&input.runningPerUser!==null&&input.runningPerUser>input.storedPerUser)computerError('computer_input_invalid',400);
  return {...input};
}
export function policyUpdate(input) {
  if(!object(input,['enabled','maximum','storedPerUser','runningPerUser','expectedRevision'])||typeof input.enabled!=='boolean'
    ||!object(input.maximum,['vcpus','memoryGiB','diskGiB'])||Object.values(input.maximum).some(v=>!Number.isSafeInteger(v)||v<=0))computerError('computer_input_invalid',400);
  quotaUpdate({storedPerUser:input.storedPerUser,runningPerUser:input.runningPerUser,expectedRevision:input.expectedRevision});
  return structuredClone(input);
}
export function quotaQuery(query={}) {
  if(query instanceof URLSearchParams){if([...query.keys()].some(k=>query.getAll(k).length!==1))computerError('computer_input_invalid',400);query=Object.fromEntries(query);}
  if(!object(query,['search','after'])||query.search!==undefined&&typeof query.search!=='string')computerError('computer_input_invalid',400);
  return {search:(query.search??'').trim(),after:query.after?computerId(query.after):null};
}
export function publicPolicy(p) {
  return {enabled:p.enabled===true,revision:p.revision??0,maximum:p.maximum??{},storedPerUser:p.storedPerUser??null,runningPerUser:p.runningPerUser??null};
}

import assert from 'node:assert/strict';
import test from 'node:test';
import {updatePreferredTheme,updatePreferredLocale,signOut} from '../src/auth/session-client.ts';

test('small account preferences survive page navigation, without keeping other operations alive',async()=>{
 const oldFetch=globalThis.fetch,oldDocument=globalThis.document,seen=[];
 globalThis.document={cookie:'__Host-teamaibox-csrf=synthetic-only'};
 globalThis.fetch=async(url,options)=>{seen.push({url,...options});return {ok:true,json:async()=>({})};};
 try{
  await updatePreferredTheme('dark');await updatePreferredLocale('en');await signOut();
  assert.deepEqual(seen.map(v=>[v.url,v.keepalive]),[['/api/preferences/theme',true],['/api/preferences/locale',true],['/api/auth/sign-out',false]]);
  for(const v of seen){assert.equal(v.credentials,'same-origin');assert.equal(v.headers['x-csrf-token'],'synthetic-only');}
 }finally{globalThis.fetch=oldFetch;if(oldDocument===undefined)delete globalThis.document;else globalThis.document=oldDocument;}
});

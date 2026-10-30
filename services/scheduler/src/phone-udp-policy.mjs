import {isIPv4} from 'node:net';

/** A concrete node listener and explicit source networks, not a URL proxy. */
export function validatePhoneUdpPolicy(value){
  const fail=()=>{throw TypeError('Invalid network camera policy');};
  const address=v=>{
    if(typeof v!=='string'||!isIPv4(v))fail();
    const [a,b]=v.split('.').map(Number);
    if(a===0||a>=224||a===169&&b===254)fail();
    return v.split('.').reduce((n,p)=>(n*256+Number(p))>>>0,0);
  };
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3
    ||!['listenAddress','listenPort','allowedSources'].every(k=>Object.hasOwn(value,k)))fail();
  address(value.listenAddress);
  if(!Number.isInteger(value.listenPort)||value.listenPort<1024||value.listenPort>65535
    ||!Array.isArray(value.allowedSources)||!value.allowedSources.length||new Set(value.allowedSources).size!==value.allowedSources.length)fail();
  for(const cidr of value.allowedSources){
    if(typeof cidr!=='string')fail();const p=cidr.split('/');
    if(p.length!==2||!/^([1-9]|[12][0-9]|3[0-2])$/.test(p[1]))fail();
    const ip=address(p[0]),mask=(0xffffffff<<(32-Number(p[1])))>>>0;
    if(((ip&mask)>>>0)!==ip)fail();
  }
  return structuredClone(value);
}

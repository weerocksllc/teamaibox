import {isIPv4} from 'node:net';
/** Keep connection probes bound to the server-observed HTTPS peer.
 * With VPN/NAT the browser's host address differs from that peer. In that
 * case use only the trusted peer as a probe hint; authenticated ICE checks
 * from the browser discover the real mapped UDP endpoint (RFC 8445 7.3.1.3).
 * Never resolve mDNS or dial an address supplied by the browser. The installed
 * receiver still validates encryption, direction and VP8.
 */
export function browserCameraOffer(raw,peer){
  const invalid=()=>{throw TypeError('phone_camera_offer_invalid');};
  if(typeof raw!=='string'||!raw.startsWith('v=0\r\n')||Buffer.byteLength(raw)>65536||raw.includes('\0')
    ||!isIPv4(peer)||!/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(peer))invalid();
  const lines=raw.split('\r\n');let count=0;
  const result=[],direct=[],hints=[];
  for(const line of lines){
    if(line.length>4096||/[\r\n]/.test(line))invalid();
    if(line.startsWith('a=candidate:')){
      if(++count>16)invalid();
      const fields=line.slice('a=candidate:'.length).split(' ');
      if(fields.length<8||fields.length>24)invalid();
      if(fields[1]!=='1'||fields[2].toLowerCase()!=='udp'||fields[6]!=='typ'||fields[7]!=='host')continue;
      const host=fields[4];
      if(!(isIPv4(host)&&/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(host))
        &&!(/^[a-zA-Z0-9-]{1,63}\.local$/.test(host)))continue;
      if(!/^\d{1,5}$/.test(fields[5])||Number(fields[5])<1024||Number(fields[5])>65535)invalid();
      if(!/^\d{1,10}$/.test(fields[3])||Number(fields[3])>0xffffffff)invalid();
      if(host===peer)direct.push(line);
      else {const hint=fields.slice(0,8);hint[4]=peer;hints.push('a=candidate:'+hint.join(' '));}
    }else if(line.startsWith('c='))result.push('c=IN IP4 0.0.0.0');
    else if(line.startsWith('a=remote-candidates:'))invalid();
    else result.push(line);
  }
  const selected=[...new Set(direct.length?direct:hints)];
  if(selected.length===0||selected.length>8)invalid();
  const end=result.indexOf('a=end-of-candidates');
  result.splice(end<0?result.length-1:end,0,...selected);
  return result.join('\r\n');
}

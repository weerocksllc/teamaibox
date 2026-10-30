import {isIPv4} from "node:net";

const invalid=()=>{throw new TypeError("phone_media_network_invalid");};
const privateAddress=value=>{
  if(typeof value!=="string" || !isIPv4(value))return false;
  const octets=value.split(".").map(Number);
  return octets[0]===10 || octets[0]===172 && octets[1]>=16 && octets[1]<=31 || octets[0]===192 && octets[1]===168;
};

/** One-to-one LAN port mapping for an authenticated, exact phone runtime.
 * The caller must obtain containerAddress/range from the installed Node Agent
 * over the verified controller connection, never a browser/Android request.
 * There is no external STUN/TURN server and no host-route modification.
 */
export function phoneMediaNetwork({nodeAddress,containerAddress,firstPort,lastPort}) {
  if(!privateAddress(nodeAddress) || !privateAddress(containerAddress) || nodeAddress===containerAddress
    || !Number.isInteger(firstPort) || firstPort<20000 || (firstPort-20000)%100!==0 || lastPort>65535 || lastPort!==firstPort+49)invalid();
  const candidate=raw=>{
    if(typeof raw!=="string" || raw.length>4096 || /[\r\n\0]/.test(raw))invalid();
    if(raw==="")return "";
    const tokens=raw.split(" ");
    if(tokens.length<8 || !/^candidate:[A-Za-z0-9+/]{1,32}$/.test(tokens[0]) || !["1","2"].includes(tokens[1])
      || !/^(udp|tcp)$/i.test(tokens[2]) || !/^\d{1,10}$/.test(tokens[3]) || !/^\d{1,5}$/.test(tokens[5]) || tokens[6]!=="typ")invalid();
    // Other interfaces (guest TAP, IPv6, loopback), another slot and relayed
    // candidates must not be converted into a reachable phone endpoint.
    if(tokens[4]!==containerAddress || tokens[7]!=="host" || Number(tokens[5])<firstPort || Number(tokens[5])>lastPort)return null;
    tokens[4]=nodeAddress;
    return tokens.join(" ");
  };
  const sdp=raw=>{
    if(typeof raw!=="string" || raw.length>196608 || !raw.startsWith("v=0\r\n") || raw.includes("\0"))invalid();
    const lines=[];
    for(const line of raw.split("\r\n")) {
      if(line.startsWith("a=candidate:")) {
        const mapped=candidate(line.slice(2));if(mapped!==null)lines.push("a="+mapped);
      } else if(line===`c=IN IP4 ${containerAddress}`)lines.push(`c=IN IP4 ${nodeAddress}`);
      else lines.push(line);
    }
    return lines.join("\r\n");
  };
  return Object.freeze({candidate,sdp,message(value){
    if(value?.message_type!=="device_msg")return value;
    const p=value.payload;
    if(p?.type==="ice-candidate") {
      const mapped=candidate(p.candidate);
      return mapped===null ? null : {...value,payload:{...p,candidate:mapped}};
    }
    if(p?.type==="offer")return {...value,payload:{...p,sdp:sdp(p.sdp)}};
    return value;
  }});
}

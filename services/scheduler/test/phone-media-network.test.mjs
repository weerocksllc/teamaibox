import test from "node:test";
import assert from "node:assert/strict";
import {phoneMediaNetwork} from "../src/phone-media-network.mjs";

const config={nodeAddress:"10.64.0.19",containerAddress:"172.25.0.2",firstPort:20000,lastPort:20049};
const ice=(address="172.25.0.2",port=20015,type="host")=>`candidate:42709 1 udp 2122260223 ${address} ${port} typ ${type} generation 0 ufrag test network-cost 999`;

test("every allocated range maps, including after address changes",()=>{
  for(let firstPort=20000;firstPort+49<=65535;firstPort+=100){
    const n=phoneMediaNetwork({...config,nodeAddress:'10.9.8.7',firstPort,lastPort:firstPort+49});
    assert.equal(n.candidate(ice('172.25.0.2',firstPort)),ice('10.9.8.7',firstPort));
  }
  for(const firstPort of [19900,20001,65500,NaN,20000.5])assert.throws(()=>phoneMediaNetwork({...config,firstPort,lastPort:firstPort+49}));
});

test("only the exact runtime's published range is converted to the LAN address",()=>{
  const n=phoneMediaNetwork(config);
  assert.equal(n.candidate(ice()),ice("10.64.0.19"));
  for(const address of ["127.0.0.1","192.168.246.1","172.25.0.3","::1","fe80::1","example.com"])
    assert.equal(n.candidate(ice(address)),null);
  for(const port of [22,8463,19999,20050,20100,65535])assert.equal(n.candidate(ice("172.25.0.2",port)),null);
  for(const type of ["relay","srflx","prflx"])assert.equal(n.candidate(ice("172.25.0.2",20015,type)),null);
});

test("SDP mapping preserves DTLS and ICE secrets and removes unpublishable interfaces",()=>{
  const n=phoneMediaNetwork(config),head="v=0\r\na=ice-pwd:synthetic-secret\r\na=fingerprint:sha-256 synthetic\r\n";
  assert.equal(n.sdp(head+`a=${ice()}\r\na=${ice("192.168.246.1")}\r\nc=IN IP4 172.25.0.2\r\n`),
    head+`a=${ice("10.64.0.19")}\r\nc=IN IP4 10.64.0.19\r\n`);
  const msg={message_type:"device_msg",payload:{type:"ice-candidate",candidate:ice(),mid:"0",mLineIndex:0}};
  assert.deepEqual(n.message(msg),{...msg,payload:{...msg.payload,candidate:ice("10.64.0.19")}});
  assert.equal(msg.payload.candidate,ice());
  assert.equal(n.message({...msg,payload:{...msg.payload,candidate:ice("172.25.0.3")}}),null);
});

test("slot two remains separate; no arbitrary node address, ports or injected SDP",()=>{
  const n=phoneMediaNetwork({...config,firstPort:20100,lastPort:20149});
  assert.equal(n.candidate(ice()),null);assert.equal(n.candidate(ice("172.25.0.2",20115)),ice("10.64.0.19",20115));
  for(const extra of [{nodeAddress:"1.1.1.1"},{nodeAddress:"localhost"},{nodeAddress:"127.0.0.1"},
    {containerAddress:"127.0.0.1"},{nodeAddress:config.containerAddress},{firstPort:20001},{lastPort:65535}])
    assert.throws(()=>phoneMediaNetwork({...config,...extra}),/phone_media_network_invalid/);
  for(const raw of [ice()+"\r\na=malicious",ice()+"\0",{},"not-a-candidate"])
    assert.throws(()=>n.candidate(raw),/phone_media_network_invalid/);
});

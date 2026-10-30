import test from 'node:test';
import assert from 'node:assert/strict';
import {browserCameraOffer} from '../src/virtual-phones/phone-browser-camera-sdp.mjs';
import {ManagedNodePhoneCamera} from '../src/virtual-phones/managed-node-phone-camera.mjs';
const candidate=(ip,port='50300',kind='host')=>`a=candidate:123 1 udp 2122260223 ${ip} ${port} typ ${kind} generation 0`;
const offer=(...c)=>['v=0','m=video 9 UDP/TLS/RTP/SAVPF 96','c=IN IP4 192.168.9.7',...c,''].join('\r\n');
test('multihomed browser offers retain only the trusted TLS client address, not VPN or another host',()=>{
  const result=browserCameraOffer(offer(candidate('10.64.0.8'),candidate('10.0.0.8'),candidate('10.64.0.9'),candidate('camera.local')),'10.64.0.8');
  assert.match(result,/10.64.0.8/);assert.ok(!result.includes('10.0.0.8'));assert.ok(!result.includes('10.64.0.9'));assert.ok(!result.includes('.local'));
  assert.ok(result.includes('c=IN IP4 0.0.0.0'));assert.equal(result.match(/a=candidate:/g).length,1);
});
test('VPN/NAT and mDNS hints target only the authenticated HTTPS peer, not the offered host',()=>{
  for(const host of ['192.168.250.236','camera.local']){
    const result=browserCameraOffer(offer(candidate(host),'a=end-of-candidates'),'10.64.0.3');
    assert.ok(!result.includes(host));assert.match(result,/a=candidate:123 1 udp 2122260223 192\.168\.10\.3 50300 typ host\r\na=end-of-candidates/);
  }
});
test('missing usable host, relay, reserved port, malformed and oversized SDP are rejected',()=>{
  for(const [raw,peer] of [[offer(candidate('metadata.example')),'10.64.0.8'],[offer(candidate('10.64.0.8','50200','relay')),'10.64.0.8'],
    [offer(candidate('10.64.0.8','80')),'10.64.0.8'],[offer(candidate('127.0.0.1')),'127.0.0.1'],
    [offer(candidate('10.64.0.8'))+'\0','10.64.0.8'],['v=0\r\n'+'x'.repeat(66000),'10.64.0.8']])assert.throws(()=>browserCameraOffer(raw,peer));
});
test('a caller cannot choose loopback, metadata, public or arbitrary host destinations',()=>{
  for(const host of ['127.0.0.1','169.254.169.254','8.8.8.8','evil.example'])assert.throws(()=>browserCameraOffer(offer(candidate(host)),'10.64.0.3'));
  const result=browserCameraOffer(offer(candidate('10.64.0.99')),'10.64.0.3');
  assert.ok(!result.includes('10.64.0.99'));assert.ok(result.includes('10.64.0.3'));
});
test('unusable signalling becomes a fixed public network error, not HTTP 500',async()=>{
  const runtime=new ManagedNodePhoneCamera({routes:{resolve(){throw Error('not reached');},capabilities(){}},nodeAgentRouter:{executePhoneCamera(){throw Error('not reached');}}});
  await assert.rejects(runtime.browserOffer({grant:{},offerSdp:'invalid',allowedAddresses:['10.64.0.3']}),e=>e.code==='phone_camera_network_unavailable'&&e.status===409);
});

import { createHash } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity as defaultCheckServerIdentity } from "node:tls";

import { PlatformError } from "../../../packages/observability/src/index.mjs";
import {PHONE_FILE_END,PHONE_FILE_MAXIMUM,readPhoneFileResponse} from './android-phone-file-command.mjs';
import {phoneMediaNetwork} from './phone-media-network.mjs';
import {PHONE_CAMERA_END,PHONE_CAMERA_MAXIMUM,PHONE_CAMERA_VIDEO_MAXIMUM,validatePhoneCameraCommand,validatePhoneCameraResult} from './android-phone-camera-command.mjs';
import { Readable } from 'node:stream';
import {validateComputerCommand,validateComputerCommandResult} from './computer-command.mjs';

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;
const HEADER = /^[a-z0-9-]{1,64}$/;
const MAX_RESPONSE_BYTES = 1 << 20;
const MAX_COMMAND_TIMEOUT_MILLISECONDS = 4 * 60 * 60_000;

function credential(value, name) {
  if (!Buffer.isBuffer(value) || value.byteLength < 32 || value.byteLength > (1 << 20)) {
    throw new TypeError(`Node Agent ${name} is invalid`);
  }
  return Buffer.from(value);
}

/** TLS 1.3 mTLS transport with both PKI verification and exact leaf pinning. */
export class NodeAgentHttpsTransport {
  #host; #port; #serverName; #fingerprints; #ca; #cert; #key; #request; #check; #timeout;

  constructor({ host, port = 9443, expectedServerName, expectedCertificateFingerprint,
    expectedCertificateFingerprints,
    ca, certificate, privateKey, timeoutMilliseconds = 10_000,
    requestImplementation = httpsRequest, checkServerIdentityImplementation = defaultCheckServerIdentity }) {
    const fingerprints = expectedCertificateFingerprints === undefined
      ? [expectedCertificateFingerprint]
      : expectedCertificateFingerprints;
    if (!HOST.test(host ?? "") || !HOST.test(expectedServerName ?? "") || !Array.isArray(fingerprints)
        || fingerprints.length < 1 || fingerprints.length > 2 || new Set(fingerprints).size !== fingerprints.length
        || fingerprints.some((value) => !SHA256.test(value ?? ""))
        || (expectedCertificateFingerprints !== undefined && expectedCertificateFingerprint !== undefined)
        || !Number.isSafeInteger(port) || port < 1024 || port > 65535
        || !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1_000 || timeoutMilliseconds > 60_000
        || typeof requestImplementation !== "function" || typeof checkServerIdentityImplementation !== "function") {
      throw new TypeError("Node Agent HTTPS route is invalid");
    }
    this.#host = host; this.#port = port; this.#serverName = expectedServerName;
    this.#fingerprints = new Set(fingerprints); this.#ca = credential(ca, "CA certificate");
    this.#cert = credential(certificate, "client certificate"); this.#key = credential(privateKey, "client private key");
    this.#request = requestImplementation; this.#check = checkServerIdentityImplementation; this.#timeout = timeoutMilliseconds;
  }

  async postCommand({ path, body, headers, timeoutMilliseconds = this.#timeout, maximumResponseBytes = MAX_RESPONSE_BYTES }) {
    if (path !== "/v1/commands" || typeof body !== "string" || Buffer.byteLength(body) > (1 << 20)
        || !headers || Object.entries(headers).some(([name, value]) => !HEADER.test(name) || typeof value !== "string" || value.length > 512)
        || !Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds < 1_000
        || timeoutMilliseconds > MAX_COMMAND_TIMEOUT_MILLISECONDS
        || !Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1_024 || maximumResponseBytes > (24 << 20)) {
      throw new TypeError("Node Agent HTTPS command is invalid");
    }
    const options = {
      host: this.#host, port: this.#port, servername: this.#serverName, path, method: "POST",
      minVersion: "TLSv1.3", maxVersion: "TLSv1.3", rejectUnauthorized: true,
      ca: this.#ca, cert: this.#cert, key: this.#key, timeout: timeoutMilliseconds,
      headers: { ...headers, "content-length": String(Buffer.byteLength(body)), accept: "application/json" },
      checkServerIdentity: (hostname, certificate) => {
        const error = this.#check(hostname, certificate);
        if (error) return error;
        const actual = certificate?.raw ? `sha256:${createHash("sha256").update(certificate.raw).digest("hex")}` : null;
        return this.#fingerprints.has(actual) ? undefined : new Error("Node Agent certificate fingerprint mismatch");
      },
    };
    return new Promise((resolve, reject) => {
      const outgoing = this.#request(options, (incoming) => {
        const chunks = []; let size = 0;
        incoming.on("data", (chunk) => {
          size += chunk.byteLength;
          if (size > maximumResponseBytes) incoming.destroy(new Error("Node Agent response is too large"));
          else chunks.push(chunk);
        });
        incoming.once("error", reject);
        incoming.on("end", () => {
          const bytes = Buffer.concat(chunks);
          try {
            const value = JSON.parse(bytes.toString("utf8"));
            if (incoming.statusCode !== 200) {
              throw new PlatformError(value?.error?.code || "node_agent_transport_rejected",
                "Node Agent rejected the authenticated command", { status: 502, retryable: incoming.statusCode >= 500 });
            }
            resolve(value);
          } catch (error) {
            reject(error instanceof PlatformError ? error : new PlatformError("node_agent_transport_invalid",
              "Node Agent returned an invalid response", { status: 502, retryable: true, cause: error }));
          } finally { bytes.fill(0); }
        });
      });
      outgoing.once("timeout", () => outgoing.destroy(new Error("Node Agent command timed out")));
      outgoing.once("error", reject);
      outgoing.end(body);
    });
  }

  close() {
    this.#ca.fill(0);
    this.#cert.fill(0);
    this.#key.fill(0);
  }

  async transferPhoneFile({body,headers,payload,chunks,signal}) {
    if(typeof body!=='string'||Buffer.byteLength(body)>8192||!headers||Object.keys(headers).length!==3
      ||Object.entries(headers).some(([k,v])=>!['x-teamaibox-key-id','x-teamaibox-nonce','x-teamaibox-signature'].includes(k)||typeof v!=='string'||!v.length||v.length>512||/[\r\n]/.test(v)))throw TypeError('Invalid phone file transport');
    const upload=['upload','install'].includes(payload.action);
    if(upload&&!chunks?.[Symbol.asyncIterator])throw TypeError('Phone file input missing');
    signal?.throwIfAborted();
    let response=null,request=null;
    const cancel=()=>{response?.destroy(Error('phone_transfer_cancelled'));request?.destroy(Error('phone_transfer_cancelled'));};
    let timer;
    const progress=()=>{clearTimeout(timer);timer=setTimeout(cancel,30000);timer.unref();};
    progress();
    const retire=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);};
    signal?.addEventListener('abort',cancel,{once:true});
    try {
      const incoming=await new Promise((resolve,reject)=>{
        request=this.#request({host:this.#host,port:this.#port,servername:this.#serverName,path:'/v1/phone-files',method:'POST',agent:false,
          minVersion:'TLSv1.3',maxVersion:'TLSv1.3',rejectUnauthorized:true,ca:this.#ca,cert:this.#cert,key:this.#key,
          headers:{...headers,'content-type':'application/octet-stream','content-length':String(upload?payload.sizeBytes+PHONE_FILE_END.length:0),
            'x-teamaibox-command':Buffer.from(body).toString('base64url')},
          checkServerIdentity:(host,certificate)=>{const error=this.#check(host,certificate);if(error)return error;
            return certificate?.raw&&this.#fingerprints.has(`sha256:${createHash('sha256').update(certificate.raw).digest('hex')}`)?undefined:Error('Node Agent certificate fingerprint mismatch');}},value=>{
              response=value;value.once('close',retire);value.on('error',()=>{});
              if(value.statusCode!==200){value.destroy();reject(Error('phone_file_transfer_rejected'));return;}resolve(value);
            });
        request.once('error',reject);
        const send=async()=>{
          let count=0;
          if(upload){for await(const chunk of chunks){signal?.throwIfAborted();if(!Buffer.isBuffer(chunk)||chunk.length>1024**2)throw Error('phone_object_invalid');
            count+=chunk.length;if(count>payload.sizeBytes||count>PHONE_FILE_MAXIMUM)throw Error('phone_upload_too_large');
            await new Promise((ok,no)=>request.write(chunk,error=>error?no(error):ok()));progress();}
            if(count!==payload.sizeBytes)throw Error('phone_object_invalid');request.end(PHONE_FILE_END);
          }else request.end();
        };
        send().catch(error=>{request.destroy(error);reject(error);});
        if(signal?.aborted)cancel();
      });
      const result=await readPhoneFileResponse(incoming,payload,{progress});
      if(payload.action!=='download')retire();
      return result;
    }catch(error){retire();cancel();throw error;}
  }

  async executeComputerInstallation({body,headers,payload,chunks,signal}){
    const selected=validateComputerCommand('installation',payload),size=selected.installation.size;
    if(typeof body!=='string'||Buffer.byteLength(body)>8192||!headers||Object.keys(headers).length!==3
      ||Object.entries(headers).some(([k,v])=>!['x-teamaibox-key-id','x-teamaibox-nonce','x-teamaibox-signature'].includes(k)||typeof v!=='string'||!v.length||v.length>512||/[\r\n]/.test(v)))throw TypeError('Invalid installation transport');
    if(size&&!chunks?.[Symbol.asyncIterator])throw TypeError('Installation input missing');
    signal?.throwIfAborted();let request,response,timer;const received=[];
    const cancel=()=>{request?.destroy(Error('computer_installation_cancelled'));response?.destroy(Error('computer_installation_cancelled'));};
    const progress=()=>{clearTimeout(timer);timer=setTimeout(cancel,30000);timer.unref();};
    signal?.addEventListener('abort',cancel,{once:true});progress();
    try{return await new Promise((resolve,reject)=>{
      request=this.#request({host:this.#host,port:this.#port,servername:this.#serverName,path:'/v1/computer-installation',method:'POST',agent:false,
        minVersion:'TLSv1.3',maxVersion:'TLSv1.3',rejectUnauthorized:true,ca:this.#ca,cert:this.#cert,key:this.#key,
        headers:{...headers,'content-type':'application/octet-stream','content-length':String(size),'x-teamaibox-command':Buffer.from(body).toString('base64url')},
        checkServerIdentity:(host,certificate)=>{const error=this.#check(host,certificate);if(error)return error;
          return certificate?.raw&&this.#fingerprints.has(`sha256:${createHash('sha256').update(certificate.raw).digest('hex')}`)?undefined:Error('Node Agent certificate fingerprint mismatch');}},value=>{
        response=value;let count=0,prefix=true;
        value.on('error',reject);value.on('aborted',()=>reject(Error('computer_installation_response_truncated')));
        value.on('data',chunk=>{
          progress();
          if(prefix){let offset=0;while(offset<chunk.length&&[9,10,13,32].includes(chunk[offset]))offset++;chunk=chunk.subarray(offset);if(!chunk.length)return;prefix=false;}
          count+=chunk.length;if(count>4096){value.destroy(Error('computer_installation_response_invalid'));return;}received.push(chunk);
        });
        value.on('end',()=>{try{
          if(value.statusCode!==200)throw Error('computer_installation_unconfirmed');
          resolve(validateComputerCommandResult('installation',selected,JSON.parse(Buffer.concat(received).toString('utf8'))));
        }catch(error){reject(error);}});
      });
      request.on('error',reject);
      (async()=>{
        let count=0;
        if(size)for await(const chunk of chunks){
          signal?.throwIfAborted();if(!Buffer.isBuffer(chunk)||chunk.length>1024**2)throw Error('computer_media_input_invalid');
          count+=chunk.length;if(count>size)throw Error('computer_media_input_invalid');
          await new Promise((ok,no)=>request.write(chunk,error=>error?no(error):ok()));progress();
        }
        if(count!==size)throw Error('computer_media_input_invalid');request.end();
      })().catch(error=>{request.destroy(error);reject(error);});
      if(signal?.aborted)cancel();
    });}finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);cancel();for(const chunk of received)chunk.fill(0);}
  }

  async executePhoneCamera({body,headers,payload,chunks,signal}){
    const selected=validatePhoneCameraCommand(payload);
    if(typeof body!=='string'||Buffer.byteLength(body)>8192||!headers||Object.keys(headers).length!==3
      ||Object.entries(headers).some(([k,v])=>!['x-teamaibox-key-id','x-teamaibox-nonce','x-teamaibox-signature'].includes(k)||typeof v!=='string'||!v.length||v.length>512||/[\r\n]/.test(v)))throw TypeError('Invalid camera transport');
    const upload=['image','video','browser-offer'].includes(selected.action);if(upload&&!chunks?.[Symbol.asyncIterator])throw TypeError('Camera input missing');
    signal?.throwIfAborted();let request,response;const received=[];let size=0;
    const cancel=()=>{request?.destroy(Error('phone_camera_cancelled'));response?.destroy(Error('phone_camera_cancelled'));};
    const fileTransfer=['image','video'].includes(selected.action);
    let timer;
    const progress=()=>{clearTimeout(timer);timer=setTimeout(cancel,fileTransfer?30_000:Math.max(1,selected.deadline-Date.now()));timer.unref();};
    progress();
    signal?.addEventListener('abort',cancel,{once:true});
    try{
      return await new Promise((resolve,reject)=>{
        request=this.#request({host:this.#host,port:this.#port,servername:this.#serverName,path:'/v1/phone-camera',method:'POST',agent:false,
          minVersion:'TLSv1.3',maxVersion:'TLSv1.3',rejectUnauthorized:true,ca:this.#ca,cert:this.#cert,key:this.#key,
          headers:{...headers,'content-type':'application/octet-stream','content-length':String(upload?selected.sizeBytes+PHONE_CAMERA_END.length:0),
            'x-teamaibox-command':Buffer.from(body).toString('base64url')},
          checkServerIdentity:(host,certificate)=>{const error=this.#check(host,certificate);if(error)return error;
            return certificate?.raw&&this.#fingerprints.has(`sha256:${createHash('sha256').update(certificate.raw).digest('hex')}`)?undefined:Error('Node Agent certificate fingerprint mismatch');}},value=>{
          response=value;value.on('error',reject);
          value.on('aborted',()=>reject(Error('phone_camera_response_truncated')));
          value.on('data',chunk=>{size+=chunk.length;if(size>(selected.action==='browser-offer'?73728:4096)){value.destroy(Error('phone_camera_response_too_large'));return;}received.push(chunk);});
          value.on('end',()=>{let raw;
            try{
              raw=Buffer.concat(received);const result=JSON.parse(raw.toString('utf8'));
              if(value.statusCode!==200){
                const code=result?.error?.code;
                throw Error([409,422,503].includes(value.statusCode)&&['phone_camera_image_unsupported','phone_camera_image_too_large','phone_camera_video_unsupported','phone_camera_video_too_large','phone_camera_source_stopped','phone_camera_storage_full','phone_camera_video_memory_unavailable','phone_camera_usb_busy','phone_camera_usb_device_changed','phone_camera_udp_port_unavailable','phone_camera_not_ready','phone_runtime_status_unavailable','phone_runtime_status_stale','phone_camera_worker_failed','phone_camera_result_invalid','phone_camera_payload_invalid','phone_stale_run','phone_stop_unconfirmed'].includes(code)?code:'phone_camera_input_rejected');
              }
              const valid=validatePhoneCameraResult(selected,result);
              if(selected.action==='browser-offer'){
                // Media LAN identity is supplied by this authenticated Agent;
                // its control hostname need not equal the current DHCP address.
                const network=phoneMediaNetwork({nodeAddress:valid.nodeAddress,containerAddress:valid.containerAddress,
                  firstPort:valid.firstPort-40,lastPort:valid.lastPort});
                // Only the inspected container and this source's reserved ten
                // ports can become reachable browser-camera candidates.
                const candidates=valid.answerSdp.split('\r\n').filter(line=>line.startsWith('a=candidate:'));
                if(candidates.length<1||candidates.length>8)throw Error('phone_media_network_invalid');
                for(const line of candidates){
                  const tokens=line.slice(2).split(' '),port=Number(tokens[5]);
                  if(tokens[4]!==valid.containerAddress||tokens[2].toLowerCase()!=='udp'||port<valid.firstPort||port>valid.lastPort)throw Error('phone_media_network_invalid');
                }
                resolve(validatePhoneCameraResult(selected,{...valid,answerSdp:network.sdp(valid.answerSdp)}));
              }else resolve(valid);
            }catch(error){reject(error);}finally{raw?.fill(0);}
          });
        });
        request.on('error',reject);
        const send=async()=>{
          if(!upload){request.end();return;}
          let count=0;
          for await(const chunk of chunks){signal?.throwIfAborted();if(!Buffer.isBuffer(chunk)||chunk.length>1024**2)throw Error('phone_camera_image_invalid');
            count+=chunk.length;if(count>selected.sizeBytes||count>(selected.action==='video'?PHONE_CAMERA_VIDEO_MAXIMUM:PHONE_CAMERA_MAXIMUM))throw Error(selected.action==='video'?'phone_camera_video_too_large':'phone_camera_image_too_large');
            await new Promise((ok,no)=>request.write(chunk,error=>error?no(error):ok()));progress();}
          if(count!==selected.sizeBytes)throw Error('phone_camera_image_invalid');request.end(PHONE_CAMERA_END);
        };
        send().catch(error=>{request.destroy(error);reject(error);});if(signal?.aborted)cancel();
      });
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',cancel);cancel();for(const chunk of received)chunk.fill(0);}
  }

  async openPhoneADB({body,headers,signal}) {
    return this.#openManagedStream({body,headers,signal,path:'/v1/phone-media/adb',upgrade:'teamaibox-adb'});
  }

  async openComputerDesktop({body,headers,signal,kind}) {
    if(!['rdp','console','audio'].includes(kind))throw TypeError('Invalid computer desktop kind');
    return this.#openManagedStream({body,headers,signal,path:'/v1/computer-desktop/'+kind,upgrade:'teamaibox-computer'});
  }

  async #openManagedStream({body,headers,signal,path,upgrade}) {
    if(typeof body!=="string" || Buffer.byteLength(body)>8192 || !headers || Object.keys(headers).length!==3
      || Object.keys(headers).some(key=>!["x-teamaibox-key-id","x-teamaibox-nonce","x-teamaibox-signature"].includes(key))
      || Object.values(headers).some(v=>typeof v!=="string" || !v.length || v.length>512 || /[\r\n]/.test(v)))throw TypeError("Invalid phone ADB transport");
    if(signal?.aborted)throw Error("phone_adb_cancelled");
    return new Promise((resolve,reject)=>{
      let stream=null,settled=false;
      const cancel=()=>{stream?.destroy();request.destroy();if(!settled){settled=true;reject(Error("phone_adb_unavailable"));}};
      const request=this.#request({host:this.#host,port:this.#port,servername:this.#serverName,method:"GET",path,
        agent:false,ca:this.#ca,cert:this.#cert,key:this.#key,minVersion:"TLSv1.3",maxVersion:"TLSv1.3",rejectUnauthorized:true,
        headers:{...headers,connection:"Upgrade",upgrade,"x-teamaibox-command":Buffer.from(body).toString("base64url")},
        checkServerIdentity:(host,certificate)=>{
          const error=this.#check(host,certificate);if(error)return error;
          return certificate?.raw && this.#fingerprints.has(`sha256:${createHash("sha256").update(certificate.raw).digest("hex")}`)
            ? undefined : Error("Node Agent certificate fingerprint mismatch");
        }});
      const timeout=setTimeout(cancel,3000);timeout.unref();
      const retire=()=>{clearTimeout(timeout);signal?.removeEventListener("abort",cancel);};
      signal?.addEventListener("abort",cancel,{once:true});
      request.once("error",()=>{retire();cancel();});
      request.once("response",response=>{response.destroy();retire();cancel();});
      request.once("upgrade",(response,socket,head)=>{
        stream=socket;
        if(settled || signal?.aborted || response.statusCode!==101 || response.headers.upgrade!==upgrade) {retire();cancel();return;}
        clearTimeout(timeout);settled=true;socket.setTimeout(0);socket.pause();
        if(head.length)socket.unshift(head);
        socket.once("close",retire);socket.on("error",()=>{});resolve(socket);
      });
      request.end();if(signal?.aborted)cancel();
    });
  }

  async openPhoneSignal({body,headers,createWebSocket,onMessage,onClose,signal}) {
    if(typeof body!=="string" || Buffer.byteLength(body)>8192 || typeof createWebSocket!=="function"
      || typeof onMessage!=="function" || typeof onClose!=="function" || !headers
      || Object.keys(headers).length!==3
      || Object.keys(headers).some(key=>!["x-teamaibox-key-id","x-teamaibox-nonce","x-teamaibox-signature"].includes(key))
      || Object.values(headers).some(v=>typeof v!=="string" || v.length<1 || v.length>512 || /[\r\n]/.test(v)))throw TypeError("Invalid phone signal transport");
    if(signal?.aborted)throw Error("phone_signal_cancelled");
    return new Promise((resolve,reject)=>{
      let opened=false,closed=false,network=null;
      const socket=createWebSocket(`wss://${this.#host.includes(":")?`[${this.#host}]`:this.#host}:${this.#port}/v1/phone-media/signal`,{
        ca:this.#ca,cert:this.#cert,key:this.#key,servername:this.#serverName,minVersion:"TLSv1.3",maxVersion:"TLSv1.3",rejectUnauthorized:true,
        followRedirects:false,handshakeTimeout:3000,perMessageDeflate:false,maxPayload:262144,maxFragments:64,maxBufferedChunks:128,
        headers:{...headers,"x-teamaibox-command":Buffer.from(body).toString("base64url")},
        checkServerIdentity:(hostname,certificate)=>{
          const error=this.#check(hostname,certificate);if(error)return error;
          const actual=certificate?.raw?`sha256:${createHash("sha256").update(certificate.raw).digest("hex")}`:null;
          return this.#fingerprints.has(actual)?undefined:Error("Node Agent certificate fingerprint mismatch");
        }
      });
      const close=()=>{
        if(closed)return;closed=true;signal?.removeEventListener("abort",close);socket.terminate();
        if(!opened)reject(Error("phone_signal_unavailable"));onClose();
      };
      signal?.addEventListener("abort",close,{once:true});
      socket.on("error",close);socket.on("close",close);
      socket.once("upgrade",response=>{
        try {
          const node=response.headers["x-teamaibox-phone-media-node"],container=response.headers["x-teamaibox-phone-media-container"],range=response.headers["x-teamaibox-phone-media-range"];
          if(node==null && container==null && range==null)return; // Legacy offline qualification only.
          // The authenticated control endpoint can be a container-local DNS
          // alias while the media address is the appliance LAN address that a
          // browser can actually reach.  The three values are supplied by the
          // exact mTLS-authenticated Node Agent and phoneMediaNetwork still
          // rejects loopback, public and malformed targets.  Comparing the LAN
          // address to the control hostname incorrectly disconnects main-node
          // phones whose Agent is reached as `local-node-agent`.
          if(typeof range!=="string" || !/^\d{5}-\d{5}$/.test(range))throw Error("phone_media_network_invalid");
          const [firstPort,lastPort]=range.split("-").map(Number);
          network=phoneMediaNetwork({nodeAddress:node,containerAddress:container,firstPort,lastPort});
        }catch{close();}
      });
      socket.on("message",(bytes,binary)=>{
        if(closed)return;
        if(binary || bytes.length>262144){close();return;}
        try{
          const value=JSON.parse(bytes.toString("utf8")),mapped=network?network.message(value):value;
          if(mapped!==null)onMessage(mapped);
        }catch{close();}finally{bytes.fill(0);}
      });
      socket.once("open",()=>{
        if(closed || signal?.aborted){close();return;}
        opened=true;resolve({send(value){if(closed || socket.readyState!==1 || socket.bufferedAmount>262144){close();return;}
          socket.send(JSON.stringify(value),error=>{if(error)close();});},close});
      });
      if(signal?.aborted)close();
    });
  }
}

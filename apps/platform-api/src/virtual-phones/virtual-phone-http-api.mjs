import { PlatformError } from "../../../../packages/observability/src/index.mjs";
import { failPhone } from "./contracts.mjs";
import { cameraError } from './phone-camera-contracts.mjs';
import { isIPv4 } from 'node:net';

const ROOT = "/api/v1/virtual-phones";
const UUID = "([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})";
const PHONE = new RegExp(`^${ROOT}/${UUID}$`, "i");
const REMOVE_RECORD = new RegExp(`^${ROOT}/${UUID}/remove-record$`, 'i');
const ACTION = new RegExp(`^${ROOT}/${UUID}/(start|stop|restart)$`, "i");
const OPERATION = new RegExp(`^${ROOT}/operations/${UUID}$`, "i");
const QUOTA = new RegExp(`^/api/v1/admin/virtual-phones/quotas/${UUID}$`, "i");
const CONNECTIONS = new RegExp(`^${ROOT}/${UUID}/connections$`, "i");
const CONNECTION = new RegExp(`^${ROOT}/${UUID}/connections/${UUID}$`, "i");
const ADB_GRANTS = new RegExp(`^${ROOT}/${UUID}/adb-grants$`, "i");
const ADB_GRANT = new RegExp(`^${ROOT}/${UUID}/adb-grants/${UUID}$`, "i");
const FILES = new RegExp(`^${ROOT}/${UUID}/(files|installations|file-exports)$`, 'i');
const CAMERA = new RegExp(`^${ROOT}/${UUID}/camera$`, 'i');
const BROWSER_CAMERA = new RegExp(`^${ROOT}/${UUID}/camera/browser/(offer|heartbeat)$`, 'i');
const USB_CAMERAS = new RegExp(`^${ROOT}/${UUID}/camera/usb-devices$`, 'i');
const ADMIN_USB_CAMERAS = new RegExp(`^/api/v1/admin/virtual-phones/nodes/${UUID}/usb-cameras$`, 'i');
const ADMIN_USB_CAMERA = new RegExp(`^/api/v1/admin/virtual-phones/nodes/${UUID}/usb-cameras/${UUID}$`, 'i');
const UDP_CAMERAS = new RegExp(`^${ROOT}/${UUID}/camera/network-sources$`, 'i');
const ADMIN_UDP_CAMERAS = new RegExp(`^/api/v1/admin/virtual-phones/nodes/${UUID}/network-cameras$`, 'i');
const ADMIN_UDP_CAMERA = new RegExp(`^/api/v1/admin/virtual-phones/nodes/${UUID}/network-cameras/${UUID}$`, 'i');
function selectedGeneration(query) {
  if(query instanceof URLSearchParams){
    if([...query.keys()].some(k=>k!=='generation')||query.getAll('generation').length!==1)failPhone('phone_input_invalid');
    query=Object.fromEntries(query);
  }
  if(Object.keys(query).some(k=>k!=='generation')||! /^[1-9][0-9]{0,15}$/.test(String(query.generation??''))
    ||!Number.isSafeInteger(Number(query.generation)))failPhone('phone_input_invalid');
  return Number(query.generation);
}
export function matchesVirtualPhoneHttpRoute(method, pathname) {
  if (REMOVE_RECORD.test(pathname)) return method === 'POST';
  if (pathname === ROOT) return ["GET", "POST"].includes(method);
  if (pathname === `${ROOT}/availability` || pathname === "/api/v1/admin/virtual-phones") return method === "GET";
  if (pathname === "/api/v1/admin/virtual-phones/feature") return method === "PUT";
  if (pathname === "/api/v1/admin/virtual-phones/quotas") return method === "GET";
  if (PHONE.test(pathname)) return ["GET", "PATCH", "DELETE"].includes(method);
  if (ACTION.test(pathname)) return method === "POST";
  if (OPERATION.test(pathname)) return method === "GET";
  if (QUOTA.test(pathname)) return method === "PUT";
  if (CONNECTIONS.test(pathname)) return method === "POST";
  if (CONNECTION.test(pathname)) return method === "DELETE";
  if (ADB_GRANTS.test(pathname)) return method === "POST";
  if (ADB_GRANT.test(pathname)) return method === "DELETE";
  if (FILES.test(pathname)) return method==='POST'||method==='GET'&&FILES.exec(pathname)[2]==='files';
  if (CAMERA.test(pathname)) return ['GET','POST','DELETE'].includes(method);
  if (BROWSER_CAMERA.test(pathname)) return method==='POST';
  if (USB_CAMERAS.test(pathname)||ADMIN_USB_CAMERAS.test(pathname)) return method==='GET';
  if (ADMIN_USB_CAMERA.test(pathname)) return method==='PUT';
  if (UDP_CAMERAS.test(pathname)||ADMIN_UDP_CAMERAS.test(pathname)) return method==='GET';
  if (ADMIN_UDP_CAMERA.test(pathname)) return method==='PUT';
  return false;
}
export class VirtualPhoneHttpApi {
  #service; #access; #files; #camera; #localNodeId;
  constructor({ service, accessService=null, fileService=null, cameraService=null, localNodeId=null }) {
    if (!["availability", "list", "get", "create", "rename", "action", "getOperation", "setQuota", "administration"]
      .every(key => typeof service?.[key] === "function")) throw new TypeError("Virtual phone HTTP service is incomplete");
    this.#service = service;
    if (accessService && !["issue","closeConnection"].every(key=>typeof accessService[key]==="function")) throw new TypeError("Phone access service is incomplete");
    this.#access=accessService;
    if(fileService&&!['upload','download','list'].every(key=>typeof fileService[key]==='function'))throw TypeError('Phone file service incomplete');
    this.#files=fileService;
    if(cameraService&&!['status','start','stop','listStates'].every(k=>typeof cameraService[k]==='function'))throw TypeError('Phone camera service incomplete');
    this.#camera=cameraService;
    this.#localNodeId=localNodeId;
  }
  matches(method, pathname) { return matchesVirtualPhoneHttpRoute(method, pathname); }
  async handleSignOut(args) { return this.#service.handleSignOut?.(args); }
  async handle({ method, pathname, context, body, headers = {}, query = {}, signal, clientAddress=null }) {
    if (!context?.identityId) throw new PlatformError("invalid_session", "请先登录。", { status: 401 });
    const json = async (value, status = 200) => ({ kind: "json", status, body: await value, headers: { "cache-control": "no-store" } });
    const key = headers["idempotency-key"];
    const udp=UDP_CAMERAS.exec(pathname),adminUdp=ADMIN_UDP_CAMERAS.exec(pathname),udpPolicy=ADMIN_UDP_CAMERA.exec(pathname);
    if(udp&&method==='GET'){
      await this.#service.get({context,phoneId:udp[1]});
      if(typeof this.#camera?.udpSources!=='function')cameraError('phone_camera_unavailable');
      return json(this.#camera.udpSources({context,phoneId:udp[1],generation:selectedGeneration(query)}));
    }
    if(adminUdp&&method==='GET'||udpPolicy&&method==='PUT'){
      await this.#service.administration({context});
      if((adminUdp??udpPolicy)[1]!==this.#localNodeId)failPhone('phone_node_unavailable');
      if((query instanceof URLSearchParams?[...query.keys()]:Object.keys(query)).length)failPhone('phone_input_invalid');
      const operation=adminUdp?'udpAdministration':'configureUdpCamera';
      if(typeof this.#camera?.[operation]!=='function')cameraError('phone_camera_unavailable');
      return json(this.#camera[operation]({context,nodeId:(adminUdp??udpPolicy)[1],...(udpPolicy?{policyId:udpPolicy[2],input:body}:{})}));
    }
    const usb=USB_CAMERAS.exec(pathname),adminUsb=ADMIN_USB_CAMERAS.exec(pathname),policy=ADMIN_USB_CAMERA.exec(pathname);
    if(usb&&method==='GET'){
      await this.#service.get({context,phoneId:usb[1]});
      if(typeof this.#camera?.usbDevices!=='function')cameraError('phone_camera_unavailable');
      return json(this.#camera.usbDevices({context,phoneId:usb[1],generation:selectedGeneration(query)}));
    }
    if(adminUsb&&method==='GET'||policy&&method==='PUT'){
      await this.#service.administration({context});
      if((adminUsb??policy)[1]!==this.#localNodeId)failPhone('phone_node_unavailable');
      if(adminUsb){
        if(typeof this.#camera?.usbAdministration!=='function')cameraError('phone_camera_unavailable');
        if((query instanceof URLSearchParams?[...query.keys()]:Object.keys(query)).length)failPhone('phone_input_invalid');
        return json(this.#camera.usbAdministration({context,nodeId:adminUsb[1]}));
      }
      if(typeof this.#camera?.configureUsbCamera!=='function')cameraError('phone_camera_unavailable');
      return json(this.#camera.configureUsbCamera({context,nodeId:policy[1],deviceId:policy[2],input:body}));
    }
    const browser=BROWSER_CAMERA.exec(pathname);
    if(browser&&method==='POST'){
      await this.#service.get({context,phoneId:browser[1]});
      const operation=browser[2]==='offer'?'browserOffer':'keepBrowserAlive';
      if(typeof this.#camera?.[operation]!=='function')cameraError('phone_camera_unavailable');
      let allowedAddresses;
      if(operation==='browserOffer'){
        // The main Web boundary overwrites X-Forwarded-For from the TLS
        // socket. This argument is server-supplied, never read from JSON.
        const peer=typeof clientAddress==='string'?clientAddress.replace(/^::ffff:/,''):'';
        if(!isIPv4(peer)||!/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(peer))cameraError('phone_camera_unavailable');
        allowedAddresses=[peer];
      }
      return json(this.#camera[operation]({context,phoneId:browser[1],input:body,signal,...(allowedAddresses?{allowedAddresses}:{})}));
    }
    const camera=CAMERA.exec(pathname);
    if(camera&&['GET','POST','DELETE'].includes(method)){
      await this.#service.get({context,phoneId:camera[1]});
      if(!this.#camera)cameraError('phone_camera_unavailable');
      if(method==='GET')return json(this.#camera.status({context,phoneId:camera[1],generation:selectedGeneration(query)}));
      return json(this.#camera[method==='POST'?'start':'stop']({context,phoneId:camera[1],input:body,signal}),method==='POST'?201:200);
    }
    const file=FILES.exec(pathname);
    if(file) {
      await this.#service.get({context,phoneId:file[1]});
      if(!this.#files)failPhone('phone_runtime_unavailable');
      if(method==='GET'&&file[2]==='files') {
        return json(this.#files.list({context,phoneId:file[1],generation:selectedGeneration(query),signal}));
      }
      if(method==='POST')return json(file[2]==='file-exports'?this.#files.download({context,phoneId:file[1],input:body,signal})
        :this.#files.upload({context,phoneId:file[1],input:body,signal,install:file[2]==='installations'}),201);
    }
    const adb=ADB_GRANTS.exec(pathname),debug=ADB_GRANT.exec(pathname);
    if(adb && method==="POST" || debug && method==="DELETE") {
      await this.#service.get({context,phoneId:(adb??debug)[1]});
      if(!this.#access)failPhone("phone_runtime_unavailable");
      if(adb) {
        if(!body || typeof body!=="object" || Array.isArray(body) || Object.keys(body).some(key=>key!=="ttlSeconds"))failPhone("phone_input_invalid");
        return json(this.#access.issue({context,phoneId:adb[1],input:{kind:"adb",...body}}),201);
      }
      return json(this.#access.closeConnection({context,phoneId:debug[1],grantId:debug[2]}));
    }
    const connections=CONNECTIONS.exec(pathname),connection=CONNECTION.exec(pathname);
    if ((connections && method==="POST") || (connection && method==="DELETE")) {
      // Ownership first, even when media is not installed. Operation-only
      // administrators cannot use a runtime-availability check to inspect peers.
      await this.#service.get({context,phoneId:(connections??connection)[1]});
      if (!this.#access) failPhone("phone_runtime_unavailable");
      return connections ? json(this.#access.issue({context,phoneId:connections[1],input:body}),201)
        : json(this.#access.closeConnection({context,phoneId:connection[1],grantId:connection[2]}));
    }
    if (pathname === ROOT && method === "GET") {
      const list=await this.#service.list({context});
      if(!this.#camera)return json(list);
      const states=await this.#camera.listStates({context,phones:list.data});
      const byPhone=new Map(states.map(({phoneId,...value})=>[phoneId,value]));
      return json({...list,data:list.data.map(p=>({...p,cameraInput:byPhone.get(p.id)??{state:'stopped',generation:p.generation}}))});
    }
    if (pathname === ROOT && method === "POST") return json(this.#service.create({ context, input: body, key }), 202);
    if (pathname === `${ROOT}/availability` && method === "GET") return json(this.#service.availability({ context }));
    if (pathname === "/api/v1/admin/virtual-phones" && method === "GET") return json(this.#service.administration({ context }));
    if (pathname === "/api/v1/admin/virtual-phones/feature" && method === "PUT") return json(this.#service.setFeature({ context, input: body }));
    if (pathname === "/api/v1/admin/virtual-phones/quotas" && method === "GET") {
      if (query instanceof URLSearchParams) {
        if ([...query.keys()].some(key => query.getAll(key).length !== 1)) failPhone("phone_input_invalid");
        query = Object.fromEntries(query);
      }
      return json(this.#service.administrationQuotas({ context, query }));
    }
    const phone = PHONE.exec(pathname);
    const retired = REMOVE_RECORD.exec(pathname);
    if (retired && method === 'POST') return json(this.#service.removeRetiredRecord({ context, phoneId: retired[1], input: body }));
    if (phone && method === "GET") return json(this.#service.get({ context, phoneId: phone[1] }));
    if (phone && method === "PATCH") return json(this.#service.rename({ context, phoneId: phone[1], input: body }));
    if (phone && method === "DELETE") return json(this.#service.action({ context, phoneId: phone[1], action: "delete", input: body, key }), 202);
    const action = ACTION.exec(pathname);
    if (action && method === "POST") return json(this.#service.action({ context, phoneId: action[1], action: action[2].toLowerCase(), input: body, key }), 202);
    const operation = OPERATION.exec(pathname);
    if (operation && method === "GET") return json(this.#service.getOperation({ context, operationId: operation[1] }));
    const quota = QUOTA.exec(pathname);
    if (quota && method === "PUT") return json(this.#service.setQuota({ context, ownerId: quota[1], input: body }));
    throw new PlatformError("not_found", "未找到此接口。", { status: 404 });
  }
}

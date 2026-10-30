import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import {createHash} from 'node:crypto';
import {reserveBufferedMedia} from './buffered-media-budget.mjs';

import { PlatformError } from "../../../packages/observability/src/index.mjs";


const TOKEN = /^[A-Za-z0-9_-]{43,171}$/;
const TRANSFER_METHODS = new Set([
  "upload", "download", "uploadPart", "completeMultipart", "downloadByReferenceId",
  "handoff.download", "handoff.storeOutput", "handoff.storeOutputPart", "handoff.completeOutput", "scoped.download",
]);
const REPLAY_SAFE_METHODS = new Set([
  "download", "list", "listUploadParts", "downloadByReferenceId", "headByReferenceId",
  "handoff.head", "handoff.download", "uploadPart", "handoff.storeOutputPart", "scoped.head", "scoped.download",
  "storage.list", "storage.find",
]);
const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));


function encode(value) {
  if (value instanceof Uint8Array) return { __type: "bytes", base64: Buffer.from(value).toString("base64") };
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  return value;
}


function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    if (value.__type === "bytes" && typeof value.base64 === "string") return Buffer.from(value.base64, "base64");
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  }
  return value;
}


async function tokenFromFile(path) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new TypeError("object RPC token file must be absolute");
  const raw = await readFile(path);
  try {
    const value = raw.toString("utf8").trim();
    if (!TOKEN.test(value)) throw new TypeError("object RPC token is invalid");
    return value;
  } finally { raw.fill(0); }
}


export class RemoteProtectedObjectService {
  #endpoint;
  #token;
  #fetch;
  #requestTimeout;
  #transferTimeout;
  #retryDelays;

  constructor({ endpoint, token, fetchImplementation = fetch,
    requestTimeoutMilliseconds = 70_000, transferTimeoutMilliseconds = 300_000,
    retryDelaysMilliseconds = [250, 1_000, 2_000] }) {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || url.hostname !== "object-service" || url.port !== "8080"
      || url.pathname !== "/internal/v1/call" || url.search || url.hash || url.username || url.password) {
      throw new TypeError("object RPC endpoint must be the internal object-service endpoint");
    }
    if (typeof token !== "string" || !TOKEN.test(token) || typeof fetchImplementation !== "function"
      || !Number.isSafeInteger(requestTimeoutMilliseconds) || requestTimeoutMilliseconds < 10
      || requestTimeoutMilliseconds > 300_000 || !Number.isSafeInteger(transferTimeoutMilliseconds)
      || transferTimeoutMilliseconds < requestTimeoutMilliseconds || transferTimeoutMilliseconds > 900_000
      || !Array.isArray(retryDelaysMilliseconds) || retryDelaysMilliseconds.length > 3
      || retryDelaysMilliseconds.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 5_000)) {
      throw new TypeError("object RPC client configuration is invalid");
    }
    this.#endpoint = url.href;
    this.#token = token;
    this.#fetch = fetchImplementation;
    this.#requestTimeout = requestTimeoutMilliseconds;
    this.#transferTimeout = transferTimeoutMilliseconds;
    this.#retryDelays = [...retryDelaysMilliseconds];
  }

  static async fromEnvironment(environment = process.env, options = {}) {
    const endpoint = environment.PLATFORM_OBJECT_SERVICE_ENDPOINT;
    const token = await tokenFromFile(environment.PLATFORM_OBJECT_SERVICE_TOKEN_FILE);
    return new RemoteProtectedObjectService({ endpoint, token, ...options });
  }

  async #call(method, input) {
    const body = Buffer.from(JSON.stringify({ method, input: encode(input) }));
    const replaySafe = REPLAY_SAFE_METHODS.has(method);
    const attempts = replaySafe ? this.#retryDelays.length + 1 : 1;
    try {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        let response;
        try {
          response = await this.#fetch(this.#endpoint, {
            method: "POST",
            headers: {
              accept: "application/json",
              authorization: `Bearer ${this.#token}`,
              "content-type": "application/json",
            },
            body,
            signal: AbortSignal.timeout(TRANSFER_METHODS.has(method) ? this.#transferTimeout : this.#requestTimeout),
          });
        } catch {
          if (attempt + 1 < attempts) { await pause(this.#retryDelays[attempt]); continue; }
          throw new PlatformError("object_service_unavailable", "Protected object service is unavailable", { status: 503, retryable: true });
        }
        const value = await response.json().catch(() => null);
        if (response.ok && value?.ok === true) return decode(value.result);
        const error = value?.error;
        const retryable = value === null || response.status >= 500 || error?.retryable === true;
        if (retryable && attempt + 1 < attempts) { await pause(this.#retryDelays[attempt]); continue; }
        throw new PlatformError(
          typeof error?.code === "string" ? error.code : "object_service_unavailable",
          typeof error?.message === "string" ? error.message : "Protected object service is unavailable",
          { status: Number.isInteger(error?.status) ? error.status : 503, retryable },
        );
      }
      throw new PlatformError("object_service_unavailable", "Protected object service is unavailable", { status: 503, retryable: true });
    } finally { body.fill(0); }
  }

  upload(input) { return this.#call("upload", input); }
  download(input) { return this.#call("download", input); }
  head(input) { return this.#call("head", input); }
  downloadStream(input) { return this.#downloadStream('downloadStream',input); }
  downloadStreamByReferenceId(input) { return this.#downloadStream('downloadStreamByReferenceId',input); }
  async #downloadStream(method,{signal,...input}) {
    const response=await this.#fetch(this.#endpoint,{method:'POST',
      headers:{accept:'application/octet-stream',authorization:`Bearer ${this.#token}`,'content-type':'application/json'},
      body:JSON.stringify({method,input:encode(input)}),signal});
    if(!response.ok){const value=await response.json().catch(()=>null);throw new PlatformError(value?.error?.code??'object_service_unavailable','Could not read the file',{status:response.status});}
    let metadata;
    try{metadata=JSON.parse(Buffer.from(response.headers.get('x-teamaibox-object-metadata')??'','base64url').toString());
      if(!Number.isSafeInteger(metadata.size)||metadata.size<1||Number(response.headers.get('content-length'))!==metadata.size)throw Error();
    }catch{await response.body?.cancel();throw new PlatformError('object_corrupt','Object stream metadata is invalid',{status:502});}
    return {metadata,chunks:(async function*(){
      const reader=response.body.getReader();let total=0;
      try{for(;;){signal?.throwIfAborted();const next=await reader.read();if(next.done)break;
        total+=next.value.length;if(total>metadata.size)throw Error('object_corrupt');
        const chunk=Buffer.from(next.value);try{yield chunk;}finally{chunk.fill(0);}
      }if(total!==metadata.size)throw Error('object_corrupt');
      }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    })()};
  }
  delete(input) { return this.#call("delete", input); }
  list(input) { return this.#call("list", input); }
  beginMultipart(input) { return this.#call("beginMultipart", input); }
  uploadPart(input) { return this.#call("uploadPart", input); }
  listUploadParts(input) { return this.#call("listUploadParts", input); }
  completeMultipart(input) { return this.#call("completeMultipart", input); }
  abortMultipart(input) { return this.#call("abortMultipart", input); }
  createScopedReference(input) { return this.#call("createScopedReference", input); }
  revokeScopedReference(input) { return this.#call("revokeScopedReference", input); }
  downloadByReferenceId(input) { return this.#call("downloadByReferenceId", input); }
  headByReferenceId(input) { return this.#call("headByReferenceId", input); }

  createObjectHandoffGateway() {
    return Object.freeze({
      resolve: (input) => this.#call("handoff.resolve", input),
      head: (input) => this.#call("handoff.head", input),
      download: async (input) => {
        if(input.range)return this.#call('handoff.download',input);
        const stream=await this.#downloadStream('handoff.downloadStream',input);
        let content,release;const chunks=stream.chunks[Symbol.asyncIterator]();
        try{
          release=reserveBufferedMedia(stream.metadata.size);
          content=Buffer.alloc(stream.metadata.size);let offset=0;const hash=createHash('sha256');
          for await(const chunk of chunks){content.set(chunk,offset);offset+=chunk.length;hash.update(chunk);}
          if(offset!==stream.metadata.size||hash.digest('hex')!==stream.metadata.integrity?.digest)throw Error('object_corrupt');
          return {metadata:stream.metadata,content,partial:false,range:{start:0,endInclusive:offset-1,total:offset}};
        }catch(error){content?.fill(0);throw error;}finally{release?.();await chunks.return?.();}
      },
      downloadStream: (input) => this.#downloadStream('handoff.downloadStream',input),
      storeOutput: (input) => this.#call("handoff.storeOutput", input),
      beginOutput: (input) => this.#call("handoff.beginOutput", input),
      storeOutputPart: (input) => this.#call("handoff.storeOutputPart", input),
      completeOutput: (input) => this.#call("handoff.completeOutput", input),
      abortOutput: (input) => this.#call("handoff.abortOutput", input),
      issue: (input) => this.#call("handoff.issue", input),
      revoke: (input) => this.#call("handoff.revoke", input),
    });
  }

  createScopedTransferGateway() {
    return Object.freeze({
      head: (input) => this.#call("scoped.head", input),
      download: (input) => this.#call("scoped.download", input),
    });
  }

  createMessagingAttachmentVerifier() {
    return Object.freeze({
      resolveAttachment: (input) => this.#call("messaging.resolveAttachment", input),
      issueDownloadReference: (input) => this.#call("messaging.issueAttachmentDownload", input),
    });
  }

  createStorageAdministrationRepository() {
    return Object.freeze({
      bindContext: (context) => {
        const client = this;
        return Object.freeze({
          list: () => client.#call("storage.list", { context }),
          find: (poolId) => client.#call("storage.find", { context, poolId }),
          create: (input) => client.#call("storage.create", { context, input }),
          replaceDataClasses: (input) => client.#call("storage.replaceDataClasses", { context, ...input }),
          transition: (input) => client.#call("storage.transition", { context, ...input }),
        });
      },
    });
  }
}

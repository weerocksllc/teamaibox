import { timingSafeEqual } from 'node:crypto';
import { PlatformError } from '../../../../packages/observability/src/index.mjs';

const PUBLIC = '/api/v1/design/editor/_integration/';
const ISSUE = '/internal/v1/design/call-proof';
const AUTHORITY = '/internal/v1/design/call-authority';
const denied = () => { throw new PlatformError('penpot_call_denied', 'The current design call is not authorized', { status: 403 }); };
function fields(body, required) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).length !== required.length || required.some(key => !Object.hasOwn(body, key))) denied();
}
function bearer(headers) {
  if (headers.cookie || headers.origin || typeof headers.authorization !== 'string') denied();
  const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(headers.authorization);
  if (!match) denied(); return match[1];
}

/** Bounded adapters for native transport proofs and explicit editor selection.
 * Private callbacks do not receive browser identities; public writes require
 * the existing platform CSRF boundary and the scoped native session. */
export class PenpotMcpHttpApi {
  #connections; #proofs; #dispatches; #key;
  constructor({ connections, proofs, dispatches, serviceKey }) {
    if (!connections?.select || !proofs?.issue || !dispatches?.consume || !/^[A-Za-z0-9_-]{43}$/.test(serviceKey ?? '')) {
      throw new TypeError('Design MCP authorities are required');
    }
    this.#connections = connections; this.#proofs = proofs; this.#dispatches = dispatches; this.#key = Buffer.from(serviceKey);
  }
  matches(method, path) { return method === 'POST' && [ISSUE, AUTHORITY, ...['current', 'select', 'heartbeat', 'disconnect', 'claim', 'recovery', 'reviewed'].map(x => PUBLIC + x)].includes(path); }
  isPrivate(path) { return path === ISSUE || path === AUTHORITY; }
  async handle({ pathname, headers = {}, body, context, nativeToken }) {
    try {
      if (pathname === ISSUE) {
        const callFields=['server', 'tool', 'sessionID', 'messageID', 'callID'];
        if(body?.prepare===true){
          fields(body,[...callFields,'prepare']);
          return {status:200,body:await this.#proofs.prepare({runtimeAuthentication:bearer(headers),call:body})};
        }
        fields(body, Object.hasOwn(body??{},'target')?[...callFields,'target']:callFields);
        return {status:200,body:await this.#proofs.issue({runtimeAuthentication:bearer(headers),call:body,target:body.target})};
      }
      if (pathname === AUTHORITY) {
        const supplied = Buffer.from(bearer(headers));
        if (supplied.length !== this.#key.length || !timingSafeEqual(supplied, this.#key)) denied();
        let result;
        if (body?.operation === 'consume') {
          fields(body, ['operation', 'userToken', 'metadata', 'tool']);
          result = await this.#proofs.consume({ mcpAuthentication: body.userToken, metadata: body.metadata, tool: body.tool });
        } else if (body?.operation === 'recheck') {
          fields(body, ['operation', 'binding']); await this.#proofs.recheck(body.binding);
          if (!Number.isSafeInteger(body.binding?.expiresAt) || body.binding.expiresAt <= Date.now()) denied();
          result = body.binding;
        } else if (body?.operation === 'dispatch') {
          fields(body, ['operation', 'binding', 'request']);
          result = { ...body.binding, ticket: await this.#dispatches.issue(body) };
        } else if (body?.operation === 'settle') {
          fields(body, ['operation', 'ticket', 'uncertain']);
          result = await this.#dispatches.settle(body);
        } else denied();
        return { status: 200, body: result };
      }
      if (!context || !nativeToken) denied();
      let result;
      const editorAuthentication={context,nativeToken};
      if (pathname === PUBLIC + 'current') {
        fields(body, []); result = await this.#connections.current({ context, nativeToken });
      } else if (pathname === PUBLIC + 'select') {
        fields(body, ['sessionID', 'fileId', 'pageId', 'expectedGeneration']);
        if(await this.#dispatches.recovery?.(editorAuthentication)){
          throw new PlatformError('penpot_write_review_required','Check the previous design write before reconnecting',{status:409});
        }
        result = await this.#connections.select({ ...body, context, nativeToken });
      } else if (pathname === PUBLIC + 'heartbeat' || pathname === PUBLIC + 'disconnect') {
        fields(body, ['connectionId', 'generation']);
        const method = pathname === PUBLIC + 'heartbeat' ? 'heartbeat' : 'disconnect';
        result = await this.#connections[method]({ ...body, context, nativeToken });
      } else if (pathname === PUBLIC + 'claim') {
        fields(body, Object.hasOwn(body??{},'workspace')?['request','ticket','workspace']:['request','ticket']);
        result = await this.#dispatches.consume({ ...body, editorAuthentication });
      } else if (pathname === PUBLIC + 'recovery') {
        fields(body, []);result={review:await this.#dispatches.recovery(editorAuthentication)};
      } else if (pathname === PUBLIC + 'reviewed') {
        fields(body, ['reviewId','fileId','pageId']);
        result=await this.#dispatches.reviewed({...body,editorAuthentication});
      } else denied();
      return { status: 200, body: result };
    } catch (error) {
      if (pathname === PUBLIC + 'select' && error?.code === 'penpot_agent_upgrade_required') {
        throw new PlatformError('penpot_agent_upgrade_required', 'The current assistant workspace has not been updated for Design', { status: 409 });
      }
      if(error?.code==='penpot_write_review_required') {
        throw new PlatformError(error.code,'Check the previous design write before reconnecting',{status:409});
      }
      if (error?.status === 409) throw new PlatformError('penpot_connection_changed', 'Select the current design connection explicitly', { status: 409 });
      // Do not send native response bodies, URLs, keys or user code to logs.
      denied();
    }
  }
  close() { this.#key.fill(0); }
}

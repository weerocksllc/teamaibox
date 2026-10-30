import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { createAgentComputeGatewayServer } from "../src/agent-compute-gateway-server.mjs";
import { AgentModelCredentialAuthority } from "../src/agent-model-credential.mjs";

const OWNER = "018f6f18-24d7-7c21-9b62-8c017419958a";
const SANDBOX = "018f6f18-24d7-7c21-9b62-8c017419958b";

function call(server, { path = "/v1/chat/completions", token, body, headers = {} }) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1", port: address.port, method: "POST", path,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }));
    });
    request.once("error", reject);
    request.end(JSON.stringify(body));
  });
}

async function fixture(t, fetchImplementation, options = {}) {
  const authority = new AgentModelCredentialAuthority({ signingKey: randomBytes(32) });
  const issued = await authority.issue({
    subject: OWNER, sandboxId: SANDBOX, audience: "compute.openai",
    scopes: ["openai:chat.completions", "openai:responses"], modelAliases: ["agent.default"],
    expiresAt: new Date(Date.now() + 300_000), singleSandbox: true,
  });
  const server = createAgentComputeGatewayServer({
    credentialAuthority: authority,
    modelAliasMap: new Map([["agent.default", "local/qwen3.6-35b-nvfp4"]]),
    platformOrigin: "http://platform-api.invalid:8080",
    fetchImplementation,
    ...options,
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, issued };
}

test("authenticates, maps the alias, preserves user claims, and restores the public model", async (t) => {
  const calls = [];
  const { server, issued } = await fixture(t, async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ id: "chatcmpl_12345678", object: "chat.completion", model: "local/qwen3.6-35b-nvfp4", choices: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const result = await call(server, {
    token: issued.token,
    headers: { "idempotency-key": "agent-turn-1" },
    body: { model: "agent.default", messages: [{ role: "user", content: "hello" }] },
  });
  assert.equal(result.status, 200, result.text);
  assert.equal(JSON.parse(result.text).model, "agent.default");
  assert.equal(calls[0].url, "http://platform-api.invalid:8080/v1/chat/completions");
  assert.equal(calls[0].body.model, "local/qwen3.6-35b-nvfp4");
  assert.equal(calls[0].body.x_teamaibox.extensions.agent.sandbox_id, SANDBOX);
  assert.equal(calls[0].body.x_teamaibox.extensions.agent.token_id, issued.tokenId);
  assert.equal(calls[0].options.headers["idempotency-key"], "agent-turn-1");
  assert.equal(calls[0].options.headers["x-forwarded-proto"], "https");
  assert.equal(calls[0].options.headers.authorization, `Bearer ${issued.token}`);
});

test("relays fragmented SSE with model projection and a terminal marker", async (t) => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('data: {"id":"chatcmpl_12345678","object":"chat.completion.chunk","model":"local/qwen3.6-35b-nvfp4","choices":[{"delta":{"content":"ok"}}]}\n'));
      controller.enqueue(encoder.encode('\ndata: [DONE]\n\n'));
      controller.close();
    },
  });
  const { server, issued } = await fixture(t, async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
  const result = await call(server, { token: issued.token, body: { model: "agent.default", stream: true, messages: [{ role: "user", content: "hello" }] } });
  assert.equal(result.status, 200, result.text);
  assert.match(result.text, /"model":"agent.default"/);
  assert.match(result.text, /data: \[DONE\]/);
  assert.equal(result.text.includes("local/qwen3.6-35b-nvfp4"), false);
});

test("derives a stable per-request idempotency key instead of replaying every turn in one sandbox", async (t) => {
  const keys = [];
  const { server, issued } = await fixture(t, async (_url, options) => {
    keys.push(options.headers["idempotency-key"]);
    return new Response(JSON.stringify({ object: "chat.completion", model: "local/qwen3.6-35b-nvfp4", choices: [] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  });
  const first = { model: "agent.default", messages: [{ role: "user", content: "first" }] };
  const second = { model: "agent.default", messages: [{ role: "user", content: "second" }] };
  assert.equal((await call(server, { token: issued.token, body: first })).status, 200);
  assert.equal((await call(server, { token: issued.token, body: first })).status, 200);
  assert.equal((await call(server, { token: issued.token, body: second })).status, 200);
  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[0], keys[2]);
  assert.match(keys[0], /^agent\.[0-9a-f-]{36}\.[0-9a-f]{64}$/);
});

test("fails closed for unlisted models, invalid tokens, routes, and upstream error bodies", async (t) => {
  let calls = 0;
  const { server, issued } = await fixture(t, async () => {
    calls += 1;
    return new Response('{"secret":"must-not-cross"}', { status: 500, headers: { "content-type": "application/json" } });
  });
  const denied = await call(server, { token: issued.token, body: { model: "agent.large", messages: [{ role: "user", content: "hello" }] } });
  assert.equal(denied.status, 403);
  assert.equal(calls, 0);
  const bad = await call(server, { token: issued.token.slice(0, -1) + "x", body: { model: "agent.default", messages: [{ role: "user", content: "hello" }] } });
  assert.equal(bad.status, 401);
  const route = await call(server, { path: "/v1/images/generations", token: issued.token, body: { model: "agent.default" } });
  assert.equal(route.status, 404);
  const upstream = await call(server, { token: issued.token, body: { model: "agent.default", messages: [{ role: "user", content: "hello" }] } });
  assert.equal(upstream.status, 503);
  assert.equal(upstream.text.includes("must-not-cross"), false);
});

test("accepts a request above the former 4 MiB cap", async t => {
  const content = "x".repeat(5 * 1024 * 1024);
  const {server, issued} = await fixture(t, async (_url, options) => {
    assert.equal(JSON.parse(options.body).messages[0].content, content);
    return Response.json({model:"local/qwen3.6-35b-nvfp4",choices:[]});
  });
  assert.equal((await call(server,{token:issued.token,body:{model:"agent.default",messages:[{role:"user",content}]}})).status,200);
});

test("resource shortage rejects before forwarding and recovers without a fixed quota", async t => {
  let available = 4096, calls = 0;
  const {server, issued} = await fixture(t, async () => {
    calls++; return Response.json({choices:[]});
  }, {memoryBudget:{available:()=>available,heap:()=>available}});
  const input={token:issued.token,body:{model:"agent.default",messages:[{role:"user",content:"x".repeat(16384)}]}};
  assert.equal((await call(server,input)).status,503); assert.equal(calls,0);
  available=1024*1024;
  assert.equal((await call(server,input)).status,200); assert.equal(calls,1);
});

test("chunked upload shortage returns JSON instead of resetting the client socket", async t => {
  let calls=0;
  const {server,issued}=await fixture(t,async()=>{calls++;return Response.json({choices:[]});},
    {memoryBudget:{available:()=>4096,heap:()=>4096}});
  const result=await new Promise((resolve,reject)=>{
    const request=httpRequest({hostname:'127.0.0.1',port:server.address().port,method:'POST',path:'/v1/chat/completions',
      headers:{authorization:`Bearer ${issued.token}`,'content-type':'application/json','transfer-encoding':'chunked'}},response=>{
      const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.once('error',reject);
      response.on('end',()=>{request.destroy();resolve({status:response.statusCode,text:Buffer.concat(chunks).toString(),connection:response.headers.connection});});
    });
    request.once('error',reject);
    // Deliberately do not end the upload. The server must reject the first
    // oversized chunk without waiting for more input or dropping its response.
    request.write('{"model":"agent.default","messages":[{"role":"user","content":"'+'x'.repeat(16384));
  });
  assert.equal(result.status,503);assert.equal(result.connection,'close');
  assert.equal(JSON.parse(result.text).error.code,'media_memory_unavailable');assert.equal(calls,0);
});

test("streams more than 64 MiB without a lifetime response cap", async t => {
  let count = 0;
  const chunk = new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'x'.repeat(1024*1024)}}]})+'\r\n\r\n');
  const stream=new ReadableStream({pull(controller){
    if(count++<65)controller.enqueue(chunk);
    else {controller.enqueue(new TextEncoder().encode('data: [DONE]\r\n\r\n'));controller.close();}
  }});
  const {server,issued}=await fixture(t,async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}}));
  const result=await call(server,{token:issued.token,body:{model:'agent.default',stream:true,messages:[]}});
  assert.equal(result.status,200); assert.ok(result.text.length>64*1024*1024);
  assert.equal((result.text.match(/data: /g)||[]).length,66); assert.ok(result.text.endsWith('data: [DONE]\n\n'));
});

test("normalizes CRLF even when the network splits a CR and LF", async t => {
  const encoder=new TextEncoder();
  const stream=new ReadableStream({start(controller){for(const part of ['data: [DONE]\r','\n\r','\n'])controller.enqueue(encoder.encode(part));controller.close();}});
  const {server,issued}=await fixture(t,async()=>new Response(stream,{headers:{'content-type':'text/event-stream'}}));
  const result=await call(server,{token:issued.token,body:{model:'agent.default',stream:true,messages:[]}});
  assert.equal(result.text,'data: [DONE]\n\n');
});

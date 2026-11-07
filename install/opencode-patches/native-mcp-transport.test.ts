// Run inside the pinned source package, not against a second MCP implementation.
import { expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { CallToolRequestSchema, type CallToolRequest, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { McpCatalog } from "@/mcp/catalog"

const def: Tool = { name: "example", inputSchema: { type: "object", properties: {} } }
const options = (id: string, signal = new AbortController().signal) => ({ toolCallId: id, abortSignal: signal, messages: [] })

async function connection() {
  const requests: CallToolRequest[] = []
  const server = new Server({ name: "transport-fixture", version: "1" }, { capabilities: { tools: {} } })
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    requests.push(request)
    return { content: [{ type: "text", text: "native-result" }] }
  })
  const client = new Client({ name: "native-client", version: "1" })
  const transport = InMemoryTransport.createLinkedPair()
  await Promise.all([client.connect(transport[0]), server.connect(transport[1])])
  return {
    client, requests,
    async [Symbol.asyncDispose]() { await Promise.all([client.close(), server.close()]) },
  }
}

test("dispatch metadata stays off tool arguments and results", async () => {
  await using fixture = await connection()
  const args = { text: "synthetic" }
  const tool = McpCatalog.convertTool(def, fixture.client, 5000, async () => ({
    "teamaibox/context": { session: "session-a", message: "message-a", call: "call-a" },
  }))
  const result = await tool.execute!(args, options("call-a"))
  expect(args).toEqual({ text: "synthetic" })
  expect(fixture.requests[0].params.arguments).toEqual(args)
  expect(fixture.requests[0].params._meta?.["teamaibox/context"]).toEqual({
    session: "session-a", message: "message-a", call: "call-a",
  })
  expect(JSON.stringify(result)).not.toContain("session-a")
  expect(result).toEqual({ content: [{ type: "text", text: "native-result" }] })
})

test("concurrent calls keep per-invocation metadata", async () => {
  await using fixture = await connection()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const tool = McpCatalog.convertTool(def, fixture.client, 5000, async (opts) => {
    if (opts.toolCallId === "first") { entered.resolve(); await release.promise }
    return { "teamaibox/context": { call: opts.toolCallId } }
  })
  const first = tool.execute!({ order: 1 }, options("first"))
  await entered.promise
  await tool.execute!({ order: 2 }, options("second"))
  release.resolve()
  await first
  expect(fixture.requests.map((r) => [r.params.arguments?.order, r.params._meta?.["teamaibox/context"]]))
    .toEqual([[2, { call: "second" }], [1, { call: "first" }]])
})

test("refused dispatch never reaches the SDK server", async () => {
  await using fixture = await connection()
  const tool = McpCatalog.convertTool(def, fixture.client, 5000, async () => { throw new Error("target changed") })
  await expect(tool.execute!({}, options("refused"))).rejects.toThrow("target changed")
  expect(fixture.requests).toHaveLength(0)
})

test("cancel while dispatch is waiting does not send a request", async () => {
  await using fixture = await connection()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const controller = new AbortController()
  const tool = McpCatalog.convertTool(def, fixture.client, 5000, async () => {
    entered.resolve(); await release.promise
    return { "teamaibox/context": "must-not-send" }
  })
  const pending = tool.execute!({}, options("cancelled", controller.signal))
  await entered.promise
  controller.abort(new Error("cancelled"))
  release.resolve()
  await expect(pending).rejects.toThrow("cancelled")
  expect(fixture.requests).toHaveLength(0)
})

test("ordinary MCP and an empty hook preserve native wire semantics", async () => {
  await using fixture = await connection()
  await McpCatalog.convertTool(def, fixture.client).execute!({}, options("ordinary"))
  await McpCatalog.convertTool(def, fixture.client, 5000, async () => ({})).execute!({}, options("empty"))
  for (const request of fixture.requests) {
    expect(request.params.name).toBe("example")
    expect(request.params.arguments).toEqual({})
    expect(Object.keys(request.params._meta ?? {})).toEqual(["progressToken"])
  }
  expect(fixture.requests).toHaveLength(2)
})

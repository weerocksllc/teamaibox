#!/usr/bin/env python3
"""Copy a verified OpenCode source tree and add native per-call MCP metadata.

This does not replace the shipped upstream binary or implement an MCP client.
The candidate is built and identified separately until integration acceptance.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile

from offline_common import need


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_tree(path):
    """Compute the Git tree identity without creating a repository or trusting metadata."""
    def object_id(kind, content):
        return hashlib.sha1(kind + b' ' + str(len(content)).encode() + b'\0' + content).digest()

    entries = []
    for entry in Path(path).iterdir():
        mode = entry.lstat().st_mode
        name = os.fsencode(entry.name)
        if stat.S_ISDIR(mode):
            entries.append((name + b'/', b'40000 ' + name + b'\0' + source_tree(entry)))
        elif stat.S_ISREG(mode):
            bits = b'100755' if mode & 0o111 else b'100644'
            entries.append((name, bits + b' ' + name + b'\0' + object_id(b'blob', entry.read_bytes())))
        elif stat.S_ISLNK(mode):
            entries.append((name, b'120000 ' + name + b'\0' + object_id(b'blob', os.fsencode(os.readlink(entry)))))
        else:
            raise RuntimeError('unsupported OpenCode source entry')
    return object_id(b'tree', b''.join(value for _, value in sorted(entries)))


def replace_once(path, old, new):
    content = path.read_text()
    need(content.count(old) == 1, 'OpenCode patch context mismatch: ' + path.name)
    path.write_text(content.replace(old, new))


def patch_tree(tree):
    catalog = tree / 'packages/opencode/src/mcp/catalog.ts'
    replace_once(catalog, 'type JSONSchema7, type Tool } from "ai"',
                 'type JSONSchema7, type Tool, type ToolExecutionOptions } from "ai"')
    replace_once(catalog,
        'export function convertTool(mcpTool: MCPToolDef, client: Client, timeout?: number): Tool {',
        '''export function convertTool(
  mcpTool: MCPToolDef,
  client: Client,
  timeout?: number,
  dispatch?: (options: ToolExecutionOptions) => Promise<Record<string, unknown>>,
): Tool {''')
    replace_once(catalog, '    execute: async (args: unknown, options) => {\n',
        '''    execute: async (args: unknown, options) => {
      // Transport-only context: never merge into model arguments or tool results.
      options.abortSignal?.throwIfAborted()
      const meta = dispatch ? await dispatch(options) : undefined
      options.abortSignal?.throwIfAborted()
''')
    replace_once(catalog, '          arguments: (args || {}) as Record<string, unknown>,\n',
        '''          arguments: (args || {}) as Record<string, unknown>,
          ...(meta && Object.keys(meta).length > 0 ? { _meta: meta } : {}),
''')
    index = tree / 'packages/opencode/src/mcp/index.ts'
    replace_once(index, 'export interface McpTool {\n',
        'export interface McpTool {\n  readonly server?: string\n')
    replace_once(index, '= { def, client, timeout }', '= { def, client, timeout, server: clientName }')
    session = tree / 'packages/opencode/src/session/tools.ts'
    replace_once(session, 'const MCP_RESOURCE_TOOLS = {', '''// Server-side per-invocation metadata; not a model argument or message.
const penpotTarget = Symbol("teamaibox.penpot.confirmed-target")
type NativeMcpOptions = ToolExecutionOptions & { [penpotTarget]?: string }

const MCP_RESOURCE_TOOLS = {''')
    replace_once(session,
        '    const item = McpCatalog.convertTool(entry.def, entry.client, entry.timeout)',
        '''    const item = McpCatalog.convertTool(entry.def, entry.client, entry.timeout, (options) =>
      run.promise(
        plugin.trigger(
          "mcp.tool.dispatch",
          {
            server: entry.server ?? "",
            tool: entry.def.name,
            sessionID: input.session.id,
            messageID: input.processor.message.id,
            callID: options.toolCallId,
            target: (options as NativeMcpOptions)[penpotTarget],
          },
          { meta: {} as Record<string, unknown> },
        ).pipe(Effect.map((output) => output.meta)),
      ),
    )''')
    replace_once(session,
        '            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })\n            return yield* Effect.promise(() => execute(args, opts))',
        '''            if (entry.server === "teamaibox-penpot" && entry.def.name === "execute_code") {
              // Arbitrary JS cannot be reliably classified as read-only. Use
              // the native confirmation queue for each invocation; a prior
              // wildcard allowance never permits a later destructive call.
              const ruleset = Permission.merge(input.agent.permission, input.session.permission ?? [])
              if (Permission.evaluate(key, "*", ruleset).action === "deny") {
                yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: [] })
                throw new Error("Penpot tool denied")
              }
              opts.abortSignal?.throwIfAborted()
              const target = yield* plugin.trigger("mcp.tool.prepare", {
                server: entry.server,
                tool: entry.def.name,
                sessionID: input.session.id,
                messageID: input.processor.message.id,
                callID: opts.toolCallId,
              }, { target: "" })
              if (!/^[a-f0-9]{64}$/.test(target.target)) throw new Error("Original design target unavailable")
              yield* permission.ask({
                permission: key,
                sessionID: input.session.id,
                tool: { messageID: input.processor.message.id, callID: opts.toolCallId },
                patterns: ["Connected design: this call only"],
                metadata: { code: toRecord(args).code },
                always: [],
                ruleset: [],
              }).pipe(Effect.orDie)
              const selected: NativeMcpOptions = { ...opts, [penpotTarget]: target.target }
              return yield* Effect.promise(() => execute(args, selected))
            }
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            return yield* Effect.promise(() => execute(args, opts))''')
    plugin = tree / 'packages/plugin/src/index.ts'
    replace_once(plugin, '  "shell.env"?: (\n', '''  /**
   * Native MCP dispatch, after permission approval. Output is wire metadata only.
   * Throw to refuse dispatch. This does not grant tool permission or file access.
   */
  "mcp.tool.dispatch"?: (
    input: { server: string; tool: string; sessionID: string; messageID: string; callID: string; target?: string },
    output: { meta: Record<string, unknown> },
  ) => Promise<void>
  "mcp.tool.prepare"?: (
    input: { server: string; tool: string; sessionID: string; messageID: string; callID: string },
    output: { target: string },
  ) => Promise<void>
  "shell.env"?: (
''')


def apply(source, output):
    repository = Path(__file__).resolve().parents[1]
    source, output = Path(source), Path(output)
    need(not output.exists(), 'patch output must be new; source and existing data are preserved')
    need(not output.resolve().is_relative_to(repository), 'upstream build trees stay outside checkout')
    need(not output.resolve().is_relative_to(source.resolve()), 'output cannot be inside source')
    for path in (source, output):
        need(not any(p.is_symlink() for p in (path, *path.parents)), 'symlink in patch path')
    lockpath = repository / 'deploy/opencode-penpot-transport.lock.json'
    lock = json.loads(lockpath.read_text())
    for relative, expected in lock['contractFiles'].items():
        need(digest(source / relative) == expected, 'OpenCode input mismatch: ' + relative)
    need(source_tree(source).hex() == lock['tree'], 'OpenCode complete source tree mismatch')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='opencode-transport-', dir=output.parent) as stage:
        tree = Path(stage) / 'source'
        shutil.copytree(source, tree, symlinks=True,
                        ignore=shutil.ignore_patterns('.git', 'node_modules', 'dist'))
        need(source_tree(tree).hex() == lock['tree'], 'OpenCode copied source tree mismatch')
        patch_tree(tree)
        # A gateway-only model catalog; no network fetch at compile or first launch.
        (tree / 'teamaibox-models.json').write_text('{}\n')
        manifest = {
            'upstreamCommit': lock['commit'], 'upstreamVersion': lock['upstreamVersion'],
            'upstreamTree': lock['tree'],
            'version': lock['candidateVersion'], 'patchRevision': lock['patchRevision'], 'modifiedByPlatform': True,
            'lockSha256': digest(lockpath), 'patcherSha256': digest(Path(__file__).resolve()),
            'modified': {p: digest(tree / p) for p in lock['contractFiles']
                         if digest(tree / p) != lock['contractFiles'][p]},
            'modelsSha256': digest(tree / 'teamaibox-models.json'),
        }
        (tree / 'teamaibox-transport-patch.json').write_text(json.dumps(manifest, indent=2) + '\n')
        need(not output.exists(), 'patch output appeared during preparation')
        tree.rename(output)
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(apply(args.source, args.output))

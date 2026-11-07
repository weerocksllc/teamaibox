#!/usr/bin/env python3
"""Overlay the official MCP's authorization boundary, without replacing its SDK/tools."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
from offline_common import need
from penpot_svg_target_patch import INPUTS as SVG_INPUTS, verify as verify_svg, patch as patch_svg
from penpot_plugin_execution_patch import INPUTS as PLUGIN_INPUTS, verify as verify_plugin, patch as patch_plugin

TOOL_INPUT = 'mcp/packages/server/src/Tool.ts'
TOOL_SHA256 = '98a0c9f7ae71f391c519b88924ba57060a0b5fe0c4d945fab8d2291e8b727519'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def replace(path, old, new):
    content = path.read_text()
    need(content.count(old) == 1, 'official MCP patch context mismatch: ' + path.name)
    path.write_text(content.replace(old, new))


def apply(source, output):
    repository = Path(__file__).resolve().parents[1]
    source, output = Path(source), Path(output)
    need(not output.exists(), 'MCP output must be new; existing source is preserved')
    need(not output.resolve().is_relative_to(repository), 'MCP build tree must be outside checkout')
    need(not output.resolve().is_relative_to(source.resolve()), 'MCP output cannot be inside source')
    for path in (source, output):
        need(not any(p.is_symlink() for p in (path, *path.parents)), 'symlink in MCP patch path')
    lock = json.loads((repository / 'deploy/penpot-source.lock.json').read_text())
    contracts = ['mcp/packages/server/src/PenpotMcpServer.ts', 'mcp/packages/server/src/PluginBridge.ts']
    for path in contracts:
        need(path in lock['contractFiles'] and digest(source / path) == lock['contractFiles'][path],
             'official MCP source identity mismatch: ' + path)
    verify_svg(source)
    verify_plugin(source)
    need(digest(source / TOOL_INPUT) == TOOL_SHA256, 'official tool error contract mismatch')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='penpot-mcp-binding-', dir=output.parent) as stage:
        tree = Path(stage) / 'source'
        shutil.copytree(source, tree, symlinks=True)
        patch_svg(tree)
        patch_plugin(tree)
        # Preserve the official catch and response, but report a failed protected
        # operation with the MCP error bit so native OpenCode cannot label it success.
        replace(tree / TOOL_INPUT,
                '            return new TextResponse(`Tool execution failed: ${String(error)}`);',
                '''            const response = new TextResponse(`Tool execution failed: ${String(error)}`);
            if (this.mcpServer.designAuthority) response.isError = true;
            return response;''')
        replace(tree / TOOL_INPUT,
                '            if (this.logger.isLevelEnabled("debug")) {',
                '            if (!this.mcpServer.designAuthority && this.logger.isLevelEnabled("debug")) {')
        replace(tree / TOOL_INPUT,
                '            this.logger.error("Tool execution #%d failed: %s; error: %s", executionId, this.getToolName(), error);',
                '''            if (this.mcpServer.designAuthority) this.logger.error("Protected tool execution failed");
            else this.logger.error("Tool execution #%d failed: %s; error: %s", executionId, this.getToolName(), error);''')
        server = tree / contracts[0]
        replace(server, 'import { ApiDocs } from "./ApiDocs";',
                'import { ApiDocs } from "./ApiDocs";\nimport { DesignCallAuthority, DesignCallBinding } from "./DesignCallAuthority";')
        replace(server, '    userToken?: string;\n}', '    userToken?: string;\n    designBinding?: DesignCallBinding;\n}')
        replace(server, '    private readonly logger = createLogger("PenpotMcpServer");',
                '    public readonly designAuthority = DesignCallAuthority.fromEnvironment();\n    private readonly logger = createLogger("PenpotMcpServer");')
        replace(server, '        // read port configuration from environment variables',
                '''        if (this.designAuthority && (!isMultiUser || process.env.PENPOT_MCP_REDIS_URI)) {
            throw new Error("Protected design integration requires single-instance multi-user routing");
        }
        // read port configuration from environment variables''')
        replace(server, '            server.registerTool(tool.name, tool.config, async (args: any) => tool.instance.execute(args));',
                '''            server.registerTool(tool.name, tool.config, async (args: any, extra: { _meta?: Record<string, unknown>; signal: AbortSignal }) => {
                if (!this.designAuthority) return tool.instance.execute(args);
                const context = this.getSessionContext();
                const designBinding = await this.designAuthority.consume(
                    context?.userToken, extra._meta?.["com.teamaibox/penpot"], tool.name);
                if (extra.signal.aborted) throw new Error("Design call cancelled");
                return this.sessionContext.run({ ...context, designBinding }, () => tool.instance.execute(args));
            });''')
        replace(server, '                userToken = req.query.userToken as string | undefined;',
                '''                userToken = this.designAuthority
                    ? req.headers.authorization?.slice(7)
                    : req.query.userToken as string | undefined;''')
        replace(server, '        this.setupHttpEndpoints();', '''        if (this.designAuthority) {
            this.app.use((req: any, res: any, next: () => void) => {
                const token = /^Bearer ([A-Za-z0-9_-]{43,128})$/.exec(req.headers.authorization ?? "")?.[1];
                if (req.path !== "/mcp" || !token || req.query.userToken) {
                    res.status(403).end();
                    return;
                }
                const previous = this.streamableTransports[req.headers["mcp-session-id"]];
                if (previous && previous.userToken !== token) {
                    res.status(403).end();
                    return;
                }
                next();
            });
        }
        this.setupHttpEndpoints();''')
        replace(server, '        const segments = token.split(".");',
                '        if (process.env.TEAMAIBOX_DESIGN_AUTHORITY_URL) return "<protected>";\n        const segments = token.split(".");')
        bridge = tree / contracts[1]
        replace(bridge, '    userToken: string | null;',
                '    userToken: string | null;\n    designEditor?: { id: string; generation: number };')
        replace(bridge, '    private readonly taskTimeouts: Map<string, NodeJS.Timeout> = new Map();',
                '''    private readonly taskTimeouts: Map<string, NodeJS.Timeout> = new Map();
    private readonly designTickets = new Map<string, string>();
    private readonly designOwners = new Map<string, WebSocket>();''')
        replace(bridge, '            const userToken = url.searchParams.get("userToken");',
                '''            const authority = this.mcpServer.designAuthority;
            const editorId = request.headers["x-teamaibox-editor-connection"];
            const editorGeneration = request.headers["x-teamaibox-editor-generation"];
            const generation = typeof editorGeneration === "string" && /^[1-9][0-9]{0,15}$/.test(editorGeneration)
                ? Number(editorGeneration) : 0;
            if (authority && (!authority.acceptsProxy(request.headers["x-teamaibox-proxy-key"])
                || url.searchParams.has("userToken")
                || typeof request.headers["x-teamaibox-user-token"] !== "string"
                || !/^[A-Za-z0-9_-]{43,128}$/.test(request.headers["x-teamaibox-user-token"])
                || typeof editorId !== "string" || !/^[a-f0-9-]{36}$/.test(editorId)
                || !Number.isSafeInteger(generation) || generation < 1)) {
                ws.close(1008, "Protected editor proxy required");
                return;
            }
            const userToken = authority ? request.headers["x-teamaibox-user-token"] as string
                : url.searchParams.get("userToken");''')
        replace(bridge, '                userToken,\n                pingInterval,',
                '''                userToken,
                designEditor: authority ? { id: editorId as string, generation } : undefined,
                pingInterval,''')
        replace(bridge, '''                if (this.clientsByToken.has(userToken)) {
                    this.logger.warn("Duplicate connection for given user token; rejecting new connection");''',
                '''                const prior = this.clientsByToken.get(userToken);
                const superseded = authority && prior?.designEditor && generation > prior.designEditor.generation;
                if (prior && !superseded) {
                    this.logger.warn("Duplicate connection for given user token; rejecting new connection");''')
        replace(bridge, '                this.clientsByToken.set(userToken, connection);',
                '''                this.clientsByToken.set(userToken, connection);
                // The old peer's close handler cannot clear the new registration.
                if (superseded) prior.socket.terminate();''')
        replace(bridge, '                this.logger.debug("Received WebSocket message: %s", data.toString());',
                '                if (!this.mcpServer.designAuthority) this.logger.debug("Received WebSocket message: %s", data.toString());')
        for message in ['this.logger.info("WebSocket connection closed");',
                        'this.logger.error(error, "WebSocket connection error");']:
            replace(bridge, message, message + '''
                if (this.mcpServer.designAuthority) {
                    for (const [taskId, owner] of this.designOwners) {
                        if (owner === ws) this.rejectPendingTask(taskId, new Error("Design editor receipt lost"));
                    }
                }''')
        replace(bridge, '        this.logger.info(`Task ${taskId} rejected: ${error.message}`);',
                '''        if (this.mcpServer.designAuthority) this.logger.info("Protected editor task rejected");
        else this.logger.info(`Task ${taskId} rejected: ${error.message}`);''')
        replace(bridge, '                    this.handlePluginTaskResponse(message as PluginTaskResponse<any>);',
                '''                    if (this.mcpServer.designAuthority && this.designOwners.get(message?.id) !== ws) return;
                    this.handlePluginTaskResponse(message as PluginTaskResponse<any>);''')
        replace(bridge, '''        this.sendPluginTask(task, this.redisBridge !== undefined);
        return await task.getResultPromise();''',
                '''        const binding = this.mcpServer.getSessionContext()?.designBinding;
        const authority = this.mcpServer.designAuthority;
        let ticket: string | undefined;
        if (authority) {
            if (!binding) throw new Error("Authenticated design target required");
            await authority.recheck(binding);
            ticket = await authority.prepareDispatch(binding, task.toRequest());
            this.designTickets.set(task.id, ticket);
        }
        try {
            this.sendPluginTask(task, this.redisBridge !== undefined);
            const result = await task.getResultPromise();
            if (ticket && authority) await authority.settle(ticket, false);
            return result;
        } catch (error) {
            const owner = this.designOwners.get(task.id);
            if (!ticket || !authority || !owner) throw error;
            // The plugin may already have changed Penpot. Retire the exact
            // connection and leave a review marker; never dispatch it again.
            owner.terminate();
            await authority.settle(ticket, true).catch(() => {});
            throw new Error("Design write result needs review. Check the original design and its history before another write.");
        } finally {
            this.designTickets.delete(task.id);
            this.designOwners.delete(task.id);
        }''')
        replace(bridge, '            assertPluginResponsive(target, Date.now());',
                '''            assertPluginResponsive(target, Date.now(), this.mcpServer.designAuthority ? 15_000 : HEARTBEAT_STALE_THRESHOLD_MS);
            if (this.mcpServer.designAuthority) {
                const binding = this.mcpServer.getSessionContext()?.designBinding;
                if (!binding || target.designEditor?.id !== binding.connectionId
                    || target.designEditor.generation !== binding.generation) throw new Error("Design target changed");
                if (!this.designTickets.has(task.id)) throw new Error("Authenticated editor receipt required");
                if ([...this.designOwners.values()].includes(target.socket)) throw new Error("The selected design is busy");
                this.designOwners.set(task.id, target.socket);
            }''')
        replace(bridge, '            target.socket.send(JSON.stringify(task.toRequest()));',
                '''            target.socket.send(JSON.stringify(this.mcpServer.designAuthority
                ? { ...task.toRequest(), designContext: this.designTickets.get(task.id) } : task.toRequest()));''')
        overlay = repository / 'install/penpot-patches/DesignCallAuthority.ts'
        shutil.copyfile(overlay, tree / 'mcp/packages/server/src/DesignCallAuthority.ts')
        guard = repository / 'install/penpot-patches/TargetBoundApi.ts'
        shutil.copyfile(guard, tree / 'mcp/packages/plugin/src/TargetBoundApi.ts')
        executor = repository / 'install/penpot-patches/ProtectedExecuteCode.ts'
        shutil.copyfile(executor, tree / 'mcp/packages/plugin/src/ProtectedExecuteCode.ts')
        (tree / 'teamaibox-mcp-binding-patches.json').write_text(json.dumps({
            'upstreamCommit': lock['commit'], 'modifiedByPlatform': True,
            'status': 'protected-native-plugin-pilot-not-release-accepted',
            'patcherSha256': digest(Path(__file__).resolve()), 'overlaySha256': digest(overlay),
            'targetBoundarySha256': digest(guard),
            'protectedExecutorSha256': digest(executor),
            'pluginPatcherSha256': digest(repository / 'install/penpot_plugin_execution_patch.py'),
            'svgPatcherSha256': digest(repository / 'install/penpot_svg_target_patch.py'),
            'svgOverlaySha256': digest(repository / 'install/penpot-patches/svg-target-functions.cljs'),
            'modified': {path: digest(tree / path) for path in [*contracts, TOOL_INPUT, *SVG_INPUTS, *PLUGIN_INPUTS,
                'mcp/packages/plugin/vite.config.ts']},
        }, indent=2) + '\n')
        need(not output.exists(), 'MCP output appeared during preparation')
        tree.rename(output)
    return output


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    print(apply(args.source, args.output))

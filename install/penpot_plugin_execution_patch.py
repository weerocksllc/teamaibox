"""Version-bound use of native SES in the official MCP plugin handler."""
import hashlib
from offline_common import need

INPUTS = {
    'mcp/packages/plugin/src/main.ts': '53b46d26f0559ebdb6b4cc8b54b353111784bdba02a7d488e5f51e34f2788f24',
    'mcp/packages/plugin/vite.config.ts': '661c77b11c8120f239b6033c28828bfcbda5d19f6cc85260f06f9e91faa0ad7b',
    'mcp/packages/plugin/src/plugin.ts': 'ebd842ceb45557545fedc9f6eadb9768d1c9a48a4e509f43ed804ffe71fb604f',
    'mcp/packages/plugin/src/TaskHandler.ts': '2d54de8ddce2061e5422eba73de70d3c66f41df7c17d695454759573ce419062',
    'mcp/packages/plugin/src/PenpotUtils.ts': 'a9ee9ef9ec328b52267bcfeb83fc90fd29d2f58c24b49c7501a9cf583bbc0389',
    'mcp/packages/plugin/src/task-handlers/ExecuteCodeTaskHandler.ts': '1ab34306e91c9143f61a2498881729ce6877912766ec755e3d6758cbb1fa788a',
}


def verify(source):
    for name, expected in INPUTS.items():
        need(hashlib.sha256((source / name).read_bytes()).hexdigest() == expected,
             'official plugin source identity mismatch: ' + name)


def patch(tree):
    verify(tree)
    def edit(name, old, new):
        path = tree / ('mcp/packages/plugin/src/' + name)
        text = path.read_text()
        need(text.count(old) == 1, 'official plugin context mismatch: ' + name)
        path.write_text(text.replace(old, new))

    # Use exactly the official helper implementation, with lexical API binding.
    # No helper closes over the unguarded ambient Penpot API in protected calls.
    edit('PenpotUtils.ts', 'export class PenpotUtils {',
         'export function createPenpotUtils(penpot: import("@penpot/plugin-types").Penpot) {\nclass PenpotUtils {')
    utils = tree / 'mcp/packages/plugin/src/PenpotUtils.ts'
    utils.write_text(utils.read_text() + '\nreturn PenpotUtils;\n}\nexport const PenpotUtils = createPenpotUtils(penpot);\n')
    edit('TaskHandler.ts', '        public params: TParams\n',
         '        public params: TParams,\n        public designContext?: unknown\n')
    edit('TaskHandler.ts', '        console.log("Sent task response:", response);',
         '        if (!TEAMAIBOX_PROTECTED_DESIGN) console.log("Sent task response:", response);')
    edit('plugin.ts', '    const task = new Task(request.id, request.task, request.params);',
         '    const task = new Task(request.id, request.task, request.params, request.designContext);')
    edit('plugin.ts', 'request: { id: string; task: string; params: any }',
         'request: { id: string; task: string; params: any; designContext?: unknown }')
    for line in ['console.log("Executing plugin task:", request.task, request.params);',
                 'console.log("Processing task with handler:", handler);',
                 'console.log("Task handled successfully:", task);',
                 'console.error("Error in handlePluginTaskRequest:", error);',
                 'console.error("Error handling task:", error);']:
        edit('plugin.ts', line, 'if (!TEAMAIBOX_PROTECTED_DESIGN) ' + line)
    for line in ['console.log("Sent response to MCP server:", response);',
                 'console.log("Received from MCP server:", event.data);',
                 'console.error("Failed to parse WebSocket message:", error);']:
        edit('main.ts', line, 'if (!TEAMAIBOX_PROTECTED_DESIGN) ' + line)
    handler = 'task-handlers/ExecuteCodeTaskHandler.ts'
    edit(handler, 'import { PenpotUtils } from "../PenpotUtils.ts";',
         'import { PenpotUtils } from "../PenpotUtils.ts";\nimport { ProtectedExecuteCode } from "../ProtectedExecuteCode";')
    edit(handler, '    private readonly context: any;',
         '    private readonly context: any;\n    private protectedExecutor?: ProtectedExecuteCode;')
    edit(handler, '        this.context.console.resetLog();', '''        if (TEAMAIBOX_PROTECTED_DESIGN) {
            if (typeof teamaiboxDesign === "undefined") throw new Error("Authenticated editor authority required");
            this.protectedExecutor ??= new ProtectedExecuteCode(penpot, teamaiboxDesign);
            const data = await this.protectedExecutor.execute(task.requestId, task.params, task.designContext);
            if (data.result instanceof Uint8Array) {
                data.result = ExecuteCodeTaskHandler.encodeBytesAsBase64Envelope(data.result);
            }
            task.sendSuccess(data);
            return;
        }
        this.context.console.resetLog();''')
    (tree / 'mcp/packages/plugin/src/teamaibox-design.d.ts').write_text('''declare const TEAMAIBOX_PROTECTED_DESIGN: boolean;
declare const teamaiboxDesign: import("./ProtectedExecuteCode").EditorCallAuthority;
''')
    config = tree / 'mcp/packages/plugin/vite.config.ts'
    text = config.read_text()
    need(text.count('    define: {') == 1, 'official plugin build context mismatch')
    config.write_text(text.replace('    define: {', '    define: {\n        TEAMAIBOX_PROTECTED_DESIGN: "true",'))

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { EditorTarget, EditorTargetAuthority, TargetBoundApi } from "./TargetBoundApi";
import { createPenpotUtils } from "./PenpotUtils";

/** Host-provided authorization, outside generated code and its arguments. */
export interface EditorCallAuthority extends EditorTargetAuthority {
    authorize(id: string, task: string, params: unknown, metadata: unknown): Promise<EditorTarget>;
}

declare const Compartment: new (globals: Record<string, unknown>) => {
    evaluate(source: string): unknown;
};

/** Per-invocation boundary around the official handler and native SES runtime.
 * Tool discovery, task routing and responses remain in the official plugin.
 */
export class ProtectedExecuteCode {
    private busy = false;
    private storage: Record<string, unknown> = Object.create(null);
    private storageTarget = "";

    constructor(private readonly api: any, private readonly authority: EditorCallAuthority) {}

    async execute(id: string, params: { code: string }, metadata: unknown): Promise<{ result: unknown; log: string }> {
        if (this.busy) throw new Error("The selected design is busy");
        this.busy = true;
        let boundary: TargetBoundApi | undefined;
        const timers = new Set<ReturnType<typeof setTimeout>>();
        let watchdog: ReturnType<typeof setInterval> | undefined;
        let flags: { naturalChildOrdering: unknown; throwValidationErrors: unknown } | undefined;
        try {
            const target = await this.authority.authorize(id, "executeCode", params, metadata);
            boundary = new TargetBoundApi(target, { current: () => {
                const current = this.authority.current();
                if (!current || this.api.currentFile?.id !== current.fileId
                    || this.api.currentPage?.id !== current.pageId) return undefined;
                return current;
            } });
            const storageTarget = JSON.stringify(target);
            if (storageTarget !== this.storageTarget) {
                this.storage = Object.create(null);
                this.storageTarget = storageTarget;
            }
            // The model sees the design API, never plugin UI/transport or host authority.
            const guarded = boundary.wrapEditorApi(this.api, new Set(["ui", "localStorage", "on", "off", "closePlugin"]));
            let log = "";
            const consoleApi: Record<string, (...args: unknown[]) => void> = Object.create(null);
            for (const level of ["log", "info", "warn", "error", "debug", "trace", "table", "assert"]) {
                consoleApi[level] = (...args) => {
                    boundary!.assertActive();
                    const line = args.map(arg => typeof arg === "object" ? JSON.stringify(arg) : String(arg)).join(" ");
                    if (log.length + line.length > 256_000) throw new Error("Design log limit exceeded");
                    log += `[${level.toUpperCase()}] ${line}\n`;
                };
            }
            const guardedTimeout = (callback: (...args: unknown[]) => unknown, delay = 0) => {
                boundary!.assertActive();
                if (typeof callback !== "function" || timers.size >= 64) throw new Error("Invalid design timer");
                const timer = setTimeout(() => {
                    timers.delete(timer);
                    try { boundary!.assertActive(); callback(); } catch { /* revoked callbacks cannot write */ }
                }, Math.max(0, Math.min(Number(delay) || 0, 30_000)));
                timers.add(timer);
                return timer;
            };
            const helpers = createPenpotUtils(guarded as any);
            const compartment = new Compartment({
                penpot: guarded, penpotUtils: helpers,
                storage: boundary.wrap(this.storage), console: consoleApi,
                setTimeout: guardedTimeout,
                clearTimeout: (timer: ReturnType<typeof setTimeout>) => { clearTimeout(timer); timers.delete(timer); },
                atob, btoa,
            });
            if (!this.api.flags) throw new Error("Incompatible native design API");
            flags = { naturalChildOrdering: this.api.flags.naturalChildOrdering,
                throwValidationErrors: this.api.flags.throwValidationErrors };
            this.api.flags.naturalChildOrdering = true;
            this.api.flags.throwValidationErrors = true;
            const deadline = Date.now() + 60_000;
            const revoked = new Promise<never>((_resolve, reject) => {
                watchdog = setInterval(() => {
                    try {
                        boundary!.assertActive();
                        if (Date.now() >= deadline) throw new Error("Design call timed out; check its result before retrying");
                    } catch (error) { reject(error); }
                }, 100);
            });
            const value = await Promise.race([compartment.evaluate(`(async () => { ${params.code}\n })()`), revoked]);
            boundary.assertActive();
            // Materialize results while their handles are valid; no live host references
            // are retained by native response serialization after this call closes.
            const result = value instanceof Uint8Array ? new Uint8Array(value)
                : value === undefined ? undefined : JSON.parse(JSON.stringify(value));
            return { result, log };
        } finally {
            boundary?.close();
            if (watchdog !== undefined) clearInterval(watchdog);
            for (const timer of timers) clearTimeout(timer);
            if (flags) {
                this.api.flags.naturalChildOrdering = flags.naturalChildOrdering;
                this.api.flags.throwValidationErrors = flags.throwValidationErrors;
            }
            this.busy = false;
        }
    }
}

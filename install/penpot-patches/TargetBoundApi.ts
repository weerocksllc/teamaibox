// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/** Synchronous view of the authenticated, explicitly selected editor target. */
export interface EditorTarget {
    connectionId: string;
    generation: number;
    profileId: string;
    fileId: string;
    pageId: string;
}

export interface EditorTargetAuthority {
    current(): EditorTarget | undefined;
}

/** Revocable API handles for a single native tool invocation.
 * This is an API boundary, not an evaluator or an MCP implementation. Callers
 * must use Penpot's own SES compartment and must separately fence asynchronous
 * writes inside native APIs. It cannot cancel operations already dispatched.
 */
export class TargetBoundApi {
    private active = true;
    private readonly exposed = new WeakMap<object, object>();
    private readonly originals = new WeakMap<object, object>();
    private readonly editorRoots = new WeakSet<object>();
    private readonly expected: Readonly<EditorTarget>;
    private readonly authority: EditorTargetAuthority;

    constructor(expected: EditorTarget, authority: EditorTargetAuthority) {
        if (!expected || !Number.isSafeInteger(expected.generation) || expected.generation < 1
            || [expected.connectionId, expected.profileId, expected.fileId, expected.pageId]
                .some(value => typeof value !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(value))) {
            throw new Error("Authenticated editor target required");
        }
        this.expected = Object.freeze({ connectionId: expected.connectionId, generation: expected.generation,
            profileId: expected.profileId, fileId: expected.fileId, pageId: expected.pageId });
        this.authority = authority;
        this.check();
    }

    public close(): void {
        this.active = false;
    }

    public assertActive(): void {
        this.check();
    }

    public wrapEditorApi(value: object, hidden: ReadonlySet<PropertyKey> = new Set()): unknown {
        this.editorRoots.add(value);
        return this.wrap(value, hidden);
    }

    private check(): void {
        try {
            const current = this.authority.current();
            if (this.active && current && (Object.keys(this.expected) as (keyof EditorTarget)[])
                .every(key => current[key] === this.expected[key])) return;
        } catch {
            // Authority failures must not expose host objects to generated code.
        }
        this.close();
        throw new Error("Design target is no longer active");
    }

    private allowed(key: PropertyKey): boolean {
        return typeof key !== "string" || (!key.startsWith("$")
            && !["constructor", "__proto__", "prototype"].includes(key));
    }

    private assertHandle(value: object): void {
        // Native CLJS handles carry hidden ownership fields. They never cross
        // this boundary, but are checked before every read, write and call.
        try {
            const file = Reflect.get(value, "$file");
            const page = Reflect.get(value, "$page");
            if ((file != null && String(file) !== this.expected.fileId)
                || (page != null && String(page) !== this.expected.pageId)) {
                throw new Error("Different target");
            }
        } catch { throw new Error("Design handle belongs to another target"); }
    }

    private argument(value: unknown, seen = new WeakMap<object, object>()): unknown {
        this.check();
        if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
        const original = this.originals.get(value);
        if (original) {
            this.assertHandle(original);
            return original;
        }
        if (typeof value === "function") {
            return (...args: unknown[]) => {
                this.check();
                return this.argument(value(...args.map(arg => this.wrap(arg))));
            };
        }
        if (value instanceof Uint8Array) return new Uint8Array(value);
        if (value instanceof ArrayBuffer) return value.slice(0);
        if (seen.has(value)) return seen.get(value);
        const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? [] : Object.create(null);
        seen.set(value, copy);
        for (const key of Object.keys(value)) {
            if (!this.allowed(key)) throw new Error("Unsupported design argument property");
            Reflect.set(copy, key, this.argument(Reflect.get(value, key), seen));
        }
        return copy;
    }

    public wrap(value: unknown, hidden: ReadonlySet<PropertyKey> = new Set()): unknown {
        this.check();
        if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
        this.assertHandle(value);
        if (value instanceof Promise) {
            return value.then(result => this.wrap(result), () => {
                this.check();
                throw new Error("Native design operation failed");
            });
        }
        // Binary outputs and arrays contain copied data, never raw native handles.
        if (value instanceof Uint8Array) return new Uint8Array(value);
        if (value instanceof ArrayBuffer) return value.slice(0);
        const previous = this.exposed.get(value);
        if (previous) return previous;
        if (Array.isArray(value)) {
            const copy: unknown[] = [];
            this.exposed.set(value, copy);
            for (const item of value) copy.push(this.wrap(item));
            return copy;
        }
        const inspect = () => { this.check(); this.assertHandle(value); };
        const allowed = (key: PropertyKey) => !hidden.has(key) && this.allowed(key);
        const read = (key: PropertyKey): unknown => {
            inspect();
            if (!allowed(key)) return undefined;
            let item: unknown;
            try { item = Reflect.get(value, key, value); }
            catch { throw new Error("Native design read refused"); }
            if (typeof item !== "function") return this.wrap(item);
            return (...args: unknown[]) => {
                inspect();
                try {
                    const nativeArgs = args.map(arg => this.argument(arg));
                    if (this.editorRoots.has(value)
                        && (key === "createShapeFromSvg" || key === "createShapeFromSvgWithImages")) {
                        // Native media rechecks this host-only callback after parsing/upload
                        // and before insertion. Generated code cannot replace the fence.
                        nativeArgs.length = 1;
                        nativeArgs.push(() => { this.check(); return true; });
                    }
                    return this.wrap(Reflect.apply(item, value, nativeArgs));
                } catch {
                    // Do not leak an arbitrary thrown host object into generated code.
                    throw new Error("Native design operation refused");
                }
            };
        };
        // A separate shadow avoids exposing frozen native descriptors or prototypes.
        const shadow = Object.create(null);
        const facade = new Proxy(shadow, {
            get: (_target, key) => read(key),
            set: (_target, key, item) => {
                inspect();
                if (!allowed(key)) throw new Error("Unsupported design property");
                try { return Reflect.set(value, key, this.argument(item), value); }
                catch { throw new Error("Native design update refused"); }
            },
            has: (_target, key) => {
                inspect();
                try { return allowed(key) && Reflect.has(value, key); }
                catch { throw new Error("Native design inspection refused"); }
            },
            ownKeys: () => {
                inspect();
                try { return Reflect.ownKeys(value).filter(allowed); }
                catch { throw new Error("Native design inspection refused"); }
            },
            getOwnPropertyDescriptor: (_target, key) => {
                inspect();
                let own: boolean;
                try { own = Object.prototype.hasOwnProperty.call(value, key); }
                catch { throw new Error("Native design inspection refused"); }
                if (!allowed(key) || !own) return undefined;
                return { configurable: true, enumerable: true, get: () => read(key) };
            },
            getPrototypeOf: () => { inspect(); return null; },
            setPrototypeOf: () => false,
            defineProperty: () => false,
            deleteProperty: () => false,
            preventExtensions: () => false,
        });
        this.exposed.set(value, facade);
        this.originals.set(facade, value);
        return facade;
    }
}

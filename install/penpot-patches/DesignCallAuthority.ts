// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
import { timingSafeEqual } from "node:crypto";

/** Authenticated target returned by the platform, never by model tool arguments. */
export interface DesignCallBinding {
    identityId: string;
    platformSessionId: string;
    runtimeId: string;
    sessionID: string;
    messageID: string;
    callID: string;
    server: string;
    tool: string;
    connectionId: string;
    generation: number;
    profileId: string;
    fileId: string;
    pageId: string;
    expiresAt: number;
}

/** Narrow callback to the existing platform authorities; no tool execution or queue. */
export class DesignCallAuthority {
    private readonly url: URL;

    constructor(url: string, private readonly serviceKey: string) {
        this.url = new URL(url);
        if (!["http:", "https:"].includes(this.url.protocol) || this.url.username || this.url.password
            || this.url.search || this.url.hash || !/^[A-Za-z0-9_-]{43,128}$/.test(serviceKey)) {
            throw new Error("Invalid private design authority configuration");
        }
    }

    public static fromEnvironment(): DesignCallAuthority | undefined {
        const url = process.env.TEAMAIBOX_DESIGN_AUTHORITY_URL;
        const key = process.env.TEAMAIBOX_DESIGN_AUTHORITY_KEY;
        if (!url && !key) return undefined;
        if (!url || !key) throw new Error("Incomplete private design authority configuration");
        return new DesignCallAuthority(url, key);
    }

    public acceptsProxy(key: unknown): boolean {
        if (typeof key !== "string") return false;
        const left = Buffer.from(key), right = Buffer.from(this.serviceKey);
        return left.length === right.length && timingSafeEqual(left, right);
    }

    private async exchange(body: object): Promise<unknown> {
        const response = await fetch(this.url, {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(3000),
            headers: { "content-type": "application/json", authorization: `Bearer ${this.serviceKey}` },
            body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error("Design connection is no longer authorized");
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Design authority response missing");
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > 8192) throw new Error("Design authority response too large");
                chunks.push(value);
            }
        } finally {
            await reader.cancel();
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }

    private async request(body: object): Promise<DesignCallBinding & { ticket?: string }> {
        const result = await this.exchange(body) as DesignCallBinding & { ticket?: string };
        const fields = ["identityId", "platformSessionId", "runtimeId", "sessionID", "messageID", "callID",
            "server", "tool", "connectionId", "profileId", "fileId", "pageId"] as const;
        if (!result || fields.some(key => typeof result[key] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(result[key]))
            || !Number.isSafeInteger(result.generation) || result.generation < 1
            || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now()) {
            throw new Error("Invalid design authority response");
        }
        return Object.freeze(result);
    }

    public async consume(userToken: string | undefined, metadata: unknown, tool: string): Promise<DesignCallBinding> {
        if (!userToken || !metadata || typeof metadata !== "object") throw new Error("Design call context required");
        return this.request({ operation: "consume", userToken, metadata, tool });
    }

    public async recheck(binding: DesignCallBinding): Promise<void> {
        const current = await this.request({ operation: "recheck", binding });
        for (const key of Object.keys(binding) as (keyof DesignCallBinding)[]) {
            if (current[key] !== binding[key]) throw new Error("Design target changed");
        }
    }

    public async prepareDispatch(binding: DesignCallBinding, request: object): Promise<string> {
        const result = await this.request({ operation: "dispatch", binding, request });
        for (const key of Object.keys(binding) as (keyof DesignCallBinding)[]) {
            if (result[key] !== binding[key]) throw new Error("Design target changed");
        }
        if (!result.ticket || !/^tabpe1_[A-Za-z0-9_-]{43}$/.test(result.ticket)) {
            throw new Error("Authenticated editor receipt required");
        }
        return result.ticket;
    }

    public async settle(ticket: string, uncertain: boolean): Promise<void> {
        const result = await this.exchange({operation:"settle",ticket,uncertain}) as {received?: boolean};
        if (result?.received !== true) throw new Error("Design write receipt not confirmed");
    }
}

/**
 * Tool registry — Wish B Group 3a.
 *
 * Maps tool names declared in `agent.yaml` (`tools: [...]`) to
 * in-process handler functions the SDK can dispatch to. Both
 * consumer-registered handlers (e.g. RTK plugin) and loader-registered
 * handlers (TS plugins from `<agent-dir>/tools/<name>.ts`) land in
 * the same registry.
 *
 * The registry is deliberately boring: `register`, `get`, `list`,
 * `has`. Anything richer — permission overlays, timeouts, retries —
 * belongs in the runAgent dispatch path, not here.
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L24, L164-168.
 */
import type { ToolResolver } from "./agent.js";
export interface ToolContext {
    readonly tool: string;
    readonly sessionId: string;
    readonly iteration: number;
    readonly signal: AbortSignal;
}
export type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<unknown>;
export interface ToolRegistry {
    register(name: string, handler: ToolHandler): void;
    get(name: string): ToolHandler | undefined;
    has(name: string): boolean;
    list(): readonly string[];
    /** Replace the handler for a name if it exists; no-op otherwise. */
    override(name: string, handler: ToolHandler): boolean;
}
export declare class UnknownToolError extends Error {
    readonly toolName: string;
    constructor(name: string);
}
/** Create a fresh in-memory tool registry. Simple Map under the hood. */
export declare function createToolRegistry(): ToolRegistry;
/**
 * Adapt a `ToolRegistry` into the `ToolResolver` shape `runAgent`
 * accepts. When the requested tool is missing, throws
 * `UnknownToolError` so the wiring surfaces it as a
 * `ToolCallAfter{ok:false}` + `Error{phase:"tool"}` pair (handled
 * by the existing runAgent error plumbing — no new event needed).
 */
export declare function toolRegistryAsResolver(registry: ToolRegistry): ToolResolver;
//# sourceMappingURL=tool-registry.d.ts.map
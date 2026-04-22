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
export class UnknownToolError extends Error {
    toolName;
    constructor(name) {
        super(`unknown tool: "${name}" (registry has no handler)`);
        this.name = "UnknownToolError";
        this.toolName = name;
    }
}
/** Create a fresh in-memory tool registry. Simple Map under the hood. */
export function createToolRegistry() {
    const handlers = new Map();
    return {
        register(name, handler) {
            if (name.length === 0) {
                throw new TypeError("tool registry: name must be non-empty");
            }
            handlers.set(name, handler);
        },
        get(name) {
            return handlers.get(name);
        },
        has(name) {
            return handlers.has(name);
        },
        list() {
            return [...handlers.keys()];
        },
        override(name, handler) {
            if (!handlers.has(name))
                return false;
            handlers.set(name, handler);
            return true;
        },
    };
}
/**
 * Adapt a `ToolRegistry` into the `ToolResolver` shape `runAgent`
 * accepts. When the requested tool is missing, throws
 * `UnknownToolError` so the wiring surfaces it as a
 * `ToolCallAfter{ok:false}` + `Error{phase:"tool"}` pair (handled
 * by the existing runAgent error plumbing — no new event needed).
 */
export function toolRegistryAsResolver(registry) {
    return async (tool, args, signal) => {
        const handler = registry.get(tool);
        if (!handler)
            throw new UnknownToolError(tool);
        return await handler(args, {
            tool,
            // sessionId + iteration come from the registry consumer; we
            // don't have them here. The runAgent dispatch path already
            // emits ToolCallBefore/After with those fields, so handlers
            // can reference the event stream for correlation. When a
            // handler genuinely needs session context, wire a closure
            // during `register` or use the config snapshot.
            sessionId: "",
            iteration: 0,
            signal,
        });
    };
}
//# sourceMappingURL=tool-registry.js.map
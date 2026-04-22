/**
 * `agent.yaml` parser — Wish B Group 3.
 *
 * Minimal schema matching the folder-based agent convention from
 * wish A (khal-os/brain `.agents/<name>/agent.yaml`). Only the fields
 * the SDK needs for plugin loading + runAgent wiring are parsed here;
 * extra YAML keys are preserved on the returned `extras` bag so
 * consumers can layer their own schema on top without forking this
 * parser.
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L24, L164-168.
 */
export interface AgentBudget {
    readonly maxCost?: number;
    readonly maxIterations?: number;
    readonly maxDepth?: number;
}
export interface AgentScope {
    readonly reads?: readonly string[];
    readonly writes?: readonly string[];
}
export interface AgentSpec {
    /** Agent directory on disk — parent of agent.yaml. All tool-file
     *  resolutions are relative to this path. */
    readonly dir: string;
    readonly schemaVersion: number;
    readonly toolsApi: number;
    readonly shape: "single-step" | "loop" | "recurse";
    readonly model?: string;
    readonly tools: readonly string[];
    readonly systemPath?: string;
    readonly scope?: AgentScope;
    readonly budget?: AgentBudget;
    /** Preserved unrecognised keys — consumers layer their own schema. */
    readonly extras: Readonly<Record<string, unknown>>;
}
/**
 * Parse a raw YAML string into an `AgentSpec`. `dir` is the agent's
 * filesystem directory — used later by the tool loader to resolve
 * plugin file paths. Throws on schema violations with a precise
 * message identifying the offending key.
 */
export declare function parseAgentSpec(yamlText: string, dir: string): AgentSpec;
/**
 * Load + parse an agent directory's `agent.yaml`. Convenience wrapper
 * around `readFile` + `parseAgentSpec`. The returned `AgentSpec.dir`
 * is the absolute path of the supplied `agentDir` so downstream
 * plugin-path resolution has an anchor regardless of cwd.
 */
export declare function loadAgentSpec(agentDir: string): Promise<AgentSpec>;
/**
 * Resolve an agent-relative path to an absolute path. Exported so the
 * tool loader + consumers share a single resolution convention.
 */
export declare function resolveAgentPath(spec: AgentSpec, relative: string): string;
//# sourceMappingURL=agent-spec.d.ts.map
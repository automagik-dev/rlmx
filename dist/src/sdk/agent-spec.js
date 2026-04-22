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
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import yaml from "js-yaml";
const VALID_SHAPES = [
    "single-step",
    "loop",
    "recurse",
];
function asString(value) {
    return typeof value === "string" ? value : undefined;
}
function asNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function asStringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    const out = [];
    for (const v of value) {
        if (typeof v !== "string")
            continue;
        if (v.length === 0)
            continue;
        out.push(v);
    }
    return out;
}
function parseBudget(raw) {
    if (!raw || typeof raw !== "object")
        return undefined;
    const b = raw;
    const out = {
        maxCost: asNumber(b.max_cost ?? b.maxCost),
        maxIterations: asNumber(b.max_iterations ?? b.maxIterations),
        maxDepth: asNumber(b.max_depth ?? b.maxDepth),
    };
    if (out.maxCost === undefined &&
        out.maxIterations === undefined &&
        out.maxDepth === undefined) {
        return undefined;
    }
    return out;
}
function parseScope(raw) {
    if (!raw || typeof raw !== "object")
        return undefined;
    const s = raw;
    const reads = asStringArray(s.reads);
    const writes = asStringArray(s.writes);
    if (!reads && !writes)
        return undefined;
    return { reads, writes };
}
/**
 * Parse a raw YAML string into an `AgentSpec`. `dir` is the agent's
 * filesystem directory — used later by the tool loader to resolve
 * plugin file paths. Throws on schema violations with a precise
 * message identifying the offending key.
 */
export function parseAgentSpec(yamlText, dir) {
    let raw;
    try {
        raw = yaml.load(yamlText);
    }
    catch (err) {
        throw new Error(`agent.yaml: parse error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("agent.yaml: expected a YAML mapping at the top level");
    }
    const r = raw;
    const schemaVersion = asNumber(r.schema_version ?? r.schemaVersion) ?? 1;
    const toolsApi = asNumber(r.tools_api ?? r.toolsApi) ?? 1;
    const shapeRaw = asString(r.shape) ?? "single-step";
    if (!VALID_SHAPES.includes(shapeRaw)) {
        throw new Error(`agent.yaml: shape must be one of ${VALID_SHAPES.join(" | ")}, got "${shapeRaw}"`);
    }
    const tools = asStringArray(r.tools) ?? [];
    const systemPath = asString(r.system);
    // Build the "extras" bag by stripping the known keys from r.
    const known = new Set([
        "schema_version",
        "schemaVersion",
        "tools_api",
        "toolsApi",
        "shape",
        "model",
        "tools",
        "system",
        "scope",
        "budget",
    ]);
    const extras = {};
    for (const [k, v] of Object.entries(r)) {
        if (!known.has(k))
            extras[k] = v;
    }
    return {
        dir,
        schemaVersion,
        toolsApi,
        shape: shapeRaw,
        model: asString(r.model),
        tools,
        systemPath,
        scope: parseScope(r.scope),
        budget: parseBudget(r.budget),
        extras,
    };
}
/**
 * Load + parse an agent directory's `agent.yaml`. Convenience wrapper
 * around `readFile` + `parseAgentSpec`. The returned `AgentSpec.dir`
 * is the absolute path of the supplied `agentDir` so downstream
 * plugin-path resolution has an anchor regardless of cwd.
 */
export async function loadAgentSpec(agentDir) {
    const abs = isAbsolute(agentDir) ? agentDir : resolve(agentDir);
    const text = await readFile(join(abs, "agent.yaml"), "utf8");
    return parseAgentSpec(text, abs);
}
/**
 * Resolve an agent-relative path to an absolute path. Exported so the
 * tool loader + consumers share a single resolution convention.
 */
export function resolveAgentPath(spec, relative) {
    if (isAbsolute(relative))
        return relative;
    return resolve(dirname(join(spec.dir, "_")), relative);
}
//# sourceMappingURL=agent-spec.js.map
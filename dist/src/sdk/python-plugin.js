/**
 * Python plugin loader — Wish B Group 3b.
 *
 * Extends the G3a tool plugin loader to accept `.py` files under
 * `<agent-dir>/tools/<name>.py`. A Python plugin is a standalone
 * script the SDK spawns once per tool call:
 *
 *   SDK → spawn(`python3 <plugin.py>`, stdin=JSON args)
 *         → stdout: JSON result
 *         → stderr: diagnostic text (captured, never interpreted)
 *         → exit code: 0 pass, non-zero fail
 *
 * Plugin author contract (minimal, no framework lock-in):
 *
 *   #!/usr/bin/env python3
 *   import json, sys
 *   args = json.load(sys.stdin)
 *   # ... user logic ...
 *   json.dump(result, sys.stdout)
 *
 * Errors are surfaced via typed exceptions so the runAgent wiring
 * classifies them correctly:
 *
 *   InvalidPluginError — plugin script unreadable / interpreter missing
 *   PythonPluginTimeoutError — wall-clock budget exceeded
 *   PythonPluginError — non-zero exit or malformed stdout JSON
 *
 * Out of scope (deferred):
 *   - Heavy sandboxing (seccomp, namespaces, resource limits)
 *   - Virtualenv / dependency management
 *   - Streaming output / partial results
 *   - Cross-language tool composition
 *
 * Spec: `.genie/wishes/rlmx-sdk-upgrade/WISH.md` L24, L164-168 +
 * G3b dispatch from simone.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
export const DEFAULT_PYTHON_BIN = "python3";
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Thrown when the Python script crashes or produces invalid JSON. */
export class PythonPluginError extends Error {
    toolName;
    exitCode;
    stderr;
    stdout;
    constructor(toolName, exitCode, stderr, stdout, hint) {
        super(`python plugin "${toolName}" failed${hint ? `: ${hint}` : ""}${exitCode !== null ? ` (exit=${exitCode})` : ""}`);
        this.name = "PythonPluginError";
        this.toolName = toolName;
        this.exitCode = exitCode;
        this.stderr = stderr;
        this.stdout = stdout;
    }
}
/** Thrown when the subprocess overruns `timeoutMs`. */
export class PythonPluginTimeoutError extends Error {
    toolName;
    timeoutMs;
    constructor(toolName, timeoutMs) {
        super(`python plugin "${toolName}" timed out after ${timeoutMs}ms`);
        this.name = "PythonPluginTimeoutError";
        this.toolName = toolName;
        this.timeoutMs = timeoutMs;
    }
}
/**
 * Build a `ToolHandler` that shells out to `scriptPath`. Exported so
 * consumers can pre-register individual Python tools (e.g. a vendored
 * utility) without running the discovery step.
 */
export function makePythonPluginHandler(toolName, scriptPath, options = {}) {
    const pythonBin = options.pythonBin ?? DEFAULT_PYTHON_BIN;
    const timeoutMs = options.timeoutMs === undefined
        ? DEFAULT_TIMEOUT_MS
        : options.timeoutMs;
    const envOverride = options.env;
    return async (args, ctx) => {
        if (!existsSync(scriptPath)) {
            throw new PythonPluginError(toolName, null, "", "", `script missing at ${scriptPath}`);
        }
        const env = envOverride === undefined
            ? { ...process.env }
            : envOverride;
        const t0 = Date.now();
        let child;
        try {
            child = spawn(pythonBin, [scriptPath], {
                cwd: options.cwd,
                env,
                stdio: ["pipe", "pipe", "pipe"],
            });
        }
        catch (err) {
            throw new PythonPluginError(toolName, null, "", "", `spawn failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        const stdoutChunks = [];
        const stderrChunks = [];
        child.stdout.on("data", (c) => stdoutChunks.push(c));
        child.stderr.on("data", (c) => stderrChunks.push(c));
        // Feed args JSON to stdin + close.
        try {
            child.stdin.write(JSON.stringify(args ?? null));
            child.stdin.end();
        }
        catch {
            // ignore — stdin closure errors surface via child exit code.
        }
        // Wire timeout + abort.
        let timedOut = false;
        let timer;
        if (typeof timeoutMs === "number" && timeoutMs > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                child.kill("SIGKILL");
            }, timeoutMs);
        }
        const onAbort = () => child.kill("SIGKILL");
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        const exit = await new Promise((resolve) => {
            // Spawn-time errors (e.g. ENOENT when the interpreter path is
            // bogus) arrive via the 'error' event. Capture instead of
            // rejecting so we can wrap consistently as PythonPluginError.
            child.once("error", (error) => resolve({ code: null, signal: null, error }));
            child.once("close", (code, signal) => resolve({ code, signal }));
        });
        if (timer)
            clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const durationMs = Date.now() - t0;
        if (exit.error) {
            throw new PythonPluginError(toolName, null, stderr, stdout, `spawn failed: ${exit.error.message}`);
        }
        if (timedOut) {
            throw new PythonPluginTimeoutError(toolName, timeoutMs ?? 0);
        }
        if (ctx.signal.aborted) {
            throw new PythonPluginError(toolName, exit.code, stderr, stdout, "aborted by caller");
        }
        if (exit.code !== 0) {
            throw new PythonPluginError(toolName, exit.code, stderr, stdout, exit.signal ? `killed by ${exit.signal}` : "non-zero exit");
        }
        let value;
        try {
            value = stdout.length === 0 ? null : JSON.parse(stdout);
        }
        catch {
            throw new PythonPluginError(toolName, 0, stderr, stdout, "stdout was not valid JSON");
        }
        const result = { value, stderr, durationMs };
        // Plugin authors typically want just the value — expose full
        // result shape via a wrapper if they need diagnostics. The
        // common case returns `value`; the runAgent ToolCallAfter
        // surfaces stderr via logs already.
        return result.value;
    };
}
// ─── Loader (extension priority + discovery) ────────────────────────
async function fileExists(path) {
    try {
        const s = await stat(path);
        return s.isFile();
    }
    catch {
        return false;
    }
}
async function resolvePythonScript(agentDir, name) {
    const candidate = join(agentDir, "tools", `${name}.py`);
    if (await fileExists(candidate))
        return candidate;
    return null;
}
/**
 * For each tool in `spec.tools` that isn't already in `registry`,
 * attempt to resolve a `.py` plugin and register a subprocess-backed
 * handler. Returns the same loaded/skipped/missing breakdown the G3a
 * loader uses so callers can compose them.
 *
 * Usage pattern — run the G3a loader first (prefers .mjs/.js), then
 * this one for any remaining tool names:
 *
 *   const mj = await loadPluginTools(spec, registry);
 *   const py = await loadPythonPlugins(spec, registry);
 *   // mj.missing ∩ py.loaded  → resolved by Python
 *   // mj.missing \ py.loaded  → genuinely unresolved
 */
export async function loadPythonPlugins(spec, registry, options = {}) {
    const loaded = [];
    const skipped = [];
    const missing = [];
    for (const name of spec.tools) {
        if (registry.has(name)) {
            skipped.push(name);
            continue;
        }
        const scriptPath = await resolvePythonScript(spec.dir, name);
        if (!scriptPath) {
            missing.push(name);
            continue;
        }
        registry.register(name, makePythonPluginHandler(name, scriptPath, {
            ...options,
            // Default cwd to the agent directory so plugins can use
            // relative paths (e.g. to sibling SYSTEM.md / scope fixtures).
            cwd: options.cwd ?? spec.dir,
        }));
        loaded.push(name);
    }
    return { loaded, skipped, missing };
}
//# sourceMappingURL=python-plugin.js.map